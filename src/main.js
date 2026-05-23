const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, shell } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(app.getPath('userData'), 'data');
const ENGINE = path.join(ROOT, 'engine', 'memguard-engine.ps1');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const TRAY_ICON = path.join(ROOT, 'assets', 'tray.png');

let win;
let dashboard;
let tray;
let highCount = 0;
let lastAutoTrim = 0;
let pausedUntil = 0;
let lastCodexScan = 0;
let lastCodexAutoClean = 0;
let lastCodexScanResult = null;
let codexAutoCleanInFlight = false;

const zh = {
  cleanNow: '\u7acb\u5373\u6e05\u7406',
  pause: '\u6682\u505c\u81ea\u52a8\u6e05\u7406 1 \u5c0f\u65f6',
  resume: '\u6062\u590d\u81ea\u52a8\u6e05\u7406',
  dashboard: '\u6253\u5f00\u53ef\u89c6\u5316\u8bbe\u7f6e',
  hideWidget: '\u9690\u85cf\u684c\u9762\u5c0f\u7a97',
  showWidget: '\u663e\u793a\u684c\u9762\u5c0f\u7a97',
  logs: '\u6253\u5f00\u65e5\u5fd7',
  history: '\u6253\u5f00\u5386\u53f2',
  config: '\u6253\u5f00\u914d\u7f6e',
  exit: '\u9000\u51fa',
  settingsTitle: 'MemGuard \u8bbe\u7f6e'
};

const defaultConfig = {
  triggerPercent: 85,
  minProcessMB: 180,
  cooldownMinutes: 20,
  checkSeconds: 15,
  consecutiveHighChecks: 2,
  trimOnStart: true,
  historyLimit: 50,
  codexGuardEnabled: true,
  codexPolicyVersion: 2,
  codexAutoCleanAfterCodexExit: true,
  codexAutoCleanWhileRunning: true,
  codexCleanWhileRunning: 'current-safe',
  codexStaleMinutes: 10,
  codexMaxMcpProcesses: 40,
  codexCommitPressurePercent: 85,
  codexScanIntervalSeconds: 60,
  codexAutoCleanWhileRunningCooldownMinutes: 5,
  codexAutoCleanWhileRunningMaxKillsPerPass: 24,
  codexDryRunByDefault: true,
  codexKillAllowlist: [
    '@shell-mcp/mcp-lite',
    'shell-mcp-lite',
    '@modelcontextprotocol/server-filesystem',
    '@modelcontextprotocol/server-sequential-thinking',
    '@modelcontextprotocol/server-memory',
    '@modelcontextprotocol/server-everything',
    '@modelcontextprotocol/server-fetch',
    '@modelcontextprotocol/server-git',
    '@modelcontextprotocol/server-puppeteer',
    'node_repl.exe'
  ]
};

const codexAutoCleanWhileRunningReasons = [
  'previous-codex-session-orphan-while-running',
  'duplicate-desktop-app-server-tool'
];

ensureDataFiles();
let config = loadConfig();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

Menu.setApplicationMenu(null);

app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  showWidgetWindow();
});

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function runEngine(mode, reason = 'manual', options = {}) {
  return new Promise((resolve, reject) => {
    const codexDryRun = options.codexDryRun == null
      ? config.codexDryRunByDefault
      : Boolean(options.codexDryRun);
    const args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass',
      '-File', ENGINE,
      '-Mode', mode,
      '-MinProcessMB', String(config.minProcessMB),
      '-Reason', reason,
      '-DataDir', DATA_DIR,
      '-CodexStaleMinutes', String(config.codexStaleMinutes),
      '-CodexMaxMcpProcesses', String(config.codexMaxMcpProcesses),
      '-CodexCommitPressurePercent', String(config.codexCommitPressurePercent),
      '-CodexCleanWhileRunning', String(config.codexCleanWhileRunning),
      '-CodexMaxKillsPerPass', mode === 'codex-clean' ? String(options.codexMaxKillsPerPass || 0) : '0',
      '-CodexAllowedReasonsJson', mode === 'codex-clean' ? JSON.stringify(options.codexAllowedReasons || []) : '[]',
      '-CodexDryRun', mode === 'codex-clean' ? String(codexDryRun) : 'true',
      '-CodexKillAllowlistJson', JSON.stringify(config.codexKillAllowlist || [])
    ];

    execFile(POWERSHELL, args, { windowsHide: true, cwd: ROOT, timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }

      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2), 'utf8');
      return { ...defaultConfig };
    }
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const migrated = migrateConfig(parsed);
    if (Number(parsed.codexPolicyVersion || 0) < defaultConfig.codexPolicyVersion) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(migrated, null, 2), 'utf8');
    }
    return migrated;
  } catch {
    return { ...defaultConfig };
  }
}

function migrateConfig(loadedConfig) {
  const merged = { ...defaultConfig, ...(loadedConfig || {}) };
  if (Number(loadedConfig && loadedConfig.codexPolicyVersion || 0) < defaultConfig.codexPolicyVersion) {
    merged.codexPolicyVersion = defaultConfig.codexPolicyVersion;
    merged.codexAutoCleanWhileRunning = true;
    merged.codexCleanWhileRunning = 'current-safe';
    merged.codexKillAllowlist = mergeAllowlists(loadedConfig ? loadedConfig.codexKillAllowlist : []);
  }
  return merged;
}

function saveConfig(nextConfig) {
  const normalized = {
    ...defaultConfig,
    ...nextConfig,
    triggerPercent: clampNumber(nextConfig.triggerPercent, 50, 98, defaultConfig.triggerPercent),
    minProcessMB: clampNumber(nextConfig.minProcessMB, 50, 2048, defaultConfig.minProcessMB),
    cooldownMinutes: clampNumber(nextConfig.cooldownMinutes, 1, 240, defaultConfig.cooldownMinutes),
    checkSeconds: clampNumber(nextConfig.checkSeconds, 5, 300, defaultConfig.checkSeconds),
    consecutiveHighChecks: clampNumber(nextConfig.consecutiveHighChecks, 1, 10, defaultConfig.consecutiveHighChecks),
    historyLimit: clampNumber(nextConfig.historyLimit, 10, 500, defaultConfig.historyLimit),
    trimOnStart: Boolean(nextConfig.trimOnStart),
    codexGuardEnabled: Boolean(nextConfig.codexGuardEnabled),
    codexPolicyVersion: defaultConfig.codexPolicyVersion,
    codexAutoCleanAfterCodexExit: Boolean(nextConfig.codexAutoCleanAfterCodexExit),
    codexAutoCleanWhileRunning: Boolean(nextConfig.codexAutoCleanWhileRunning),
    codexCleanWhileRunning: normalizeChoice(nextConfig.codexCleanWhileRunning, ['current-safe', 'orphan-only', 'report-only', 'allow-stale'], defaultConfig.codexCleanWhileRunning),
    codexStaleMinutes: clampNumber(nextConfig.codexStaleMinutes, 1, 240, defaultConfig.codexStaleMinutes),
    codexMaxMcpProcesses: clampNumber(nextConfig.codexMaxMcpProcesses, 5, 1000, defaultConfig.codexMaxMcpProcesses),
    codexCommitPressurePercent: clampNumber(nextConfig.codexCommitPressurePercent, 50, 99, defaultConfig.codexCommitPressurePercent),
    codexScanIntervalSeconds: clampNumber(nextConfig.codexScanIntervalSeconds, 15, 600, defaultConfig.codexScanIntervalSeconds),
    codexAutoCleanWhileRunningCooldownMinutes: clampNumber(nextConfig.codexAutoCleanWhileRunningCooldownMinutes, 1, 240, defaultConfig.codexAutoCleanWhileRunningCooldownMinutes),
    codexAutoCleanWhileRunningMaxKillsPerPass: clampNumber(nextConfig.codexAutoCleanWhileRunningMaxKillsPerPass, 1, 100, defaultConfig.codexAutoCleanWhileRunningMaxKillsPerPass),
    codexDryRunByDefault: Boolean(nextConfig.codexDryRunByDefault),
    codexKillAllowlist: normalizeAllowlist(nextConfig.codexKillAllowlist)
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(normalized, null, 2), 'utf8');
  config = normalized;
  return config;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeChoice(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeAllowlist(value) {
  const source = Array.isArray(value) ? value : defaultConfig.codexKillAllowlist;
  const items = source
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return items.length ? [...new Set(items)] : [...defaultConfig.codexKillAllowlist];
}

function mergeAllowlists(value) {
  const loaded = Array.isArray(value) ? value : [];
  return normalizeAllowlist([...defaultConfig.codexKillAllowlist, ...loaded]);
}

function readHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function recordTrimHistory(result, reason) {
  if (!result || !result.after) return;
  const history = readHistory();
  history.unshift({
    timestamp: new Date().toISOString(),
    reason,
    freedGB: Number(result.freedGB || 0),
    trimmedProcesses: Number(result.trimmedProcesses || 0),
    beforePercent: result.before ? result.before.usedPercent : null,
    afterPercent: result.after.usedPercent,
    beforeFreeGB: result.before ? result.before.freeGB : null,
    afterFreeGB: result.after.freeGB
  });
  const limit = Math.max(10, Number(config.historyLimit || defaultConfig.historyLimit));
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, limit), null, 2), 'utf8');
}

function recordCodexHistory(result, reason) {
  if (!result || !result.before || !result.before.summary) return;
  const history = readHistory();
  history.unshift({
    timestamp: new Date().toISOString(),
    type: 'codex',
    reason,
    dryRun: Boolean(result.dryRun),
    targetCount: Number(result.targetCount || 0),
    killedCount: Number(result.killedCount || 0),
    failedCount: Number(result.failedCount || 0),
    beforeCleanable: result.before.summary.cleanableCount,
    afterCleanable: result.after && result.after.summary ? result.after.summary.cleanableCount : null,
    candidateCount: result.before.summary.candidateCount,
    commitPercent: result.before.snapshot ? result.before.snapshot.commitPercent : null
  });
  const limit = Math.max(10, Number(config.historyLimit || defaultConfig.historyLimit));
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, limit), null, 2), 'utf8');
}

async function cleanNow(reason = 'manual') {
  if (!win || win.isDestroyed()) return null;
  win.webContents.send('cleaning-state', true);
  try {
    const result = await runEngine('trim', reason);
    recordTrimHistory(result, reason);
    win.webContents.send('trim-result', result);
    updateTrayMenu();
    return result;
  } catch (error) {
    win.webContents.send('engine-error', error.message);
    return null;
  } finally {
    win.webContents.send('cleaning-state', false);
  }
}

async function codexScan(force = true) {
  const now = Date.now();
  const intervalMs = Math.max(15, Number(config.codexScanIntervalSeconds || defaultConfig.codexScanIntervalSeconds)) * 1000;
  if (!force && lastCodexScanResult && now - lastCodexScan < intervalMs) {
    return lastCodexScanResult;
  }
  const result = await runEngine('codex-scan', 'scan');
  lastCodexScan = now;
  lastCodexScanResult = result;
  return result;
}

async function codexClean(reason = 'codex-manual', dryRun = config.codexDryRunByDefault) {
  const result = await runEngine('codex-clean', reason, { codexDryRun: dryRun });
  recordCodexHistory(result, reason);
  return result;
}

function shouldAutoCleanCodex(scan, now = Date.now()) {
  if (!config.codexGuardEnabled || !scan || !scan.codex || !scan.summary) {
    return false;
  }
  if (codexAutoCleanInFlight) {
    return false;
  }

  const cleanableCount = Number(scan.summary.cleanableCount || 0);
  if (cleanableCount <= 0) {
    return false;
  }

  const codexRunning = Boolean(scan.codex.running);
  if (codexRunning && !config.codexAutoCleanWhileRunning) {
    return false;
  }
  if (!codexRunning && !config.codexAutoCleanAfterCodexExit) {
    return false;
  }

  const cleanableItems = Array.isArray(scan.cleanable) ? scan.cleanable : [];
  const hasPressure = Boolean(scan.summary.overProcessLimit || scan.summary.overCommitPressure);
  const hasCurrentSafeReason = cleanableItems.some((item) =>
    item && codexAutoCleanWhileRunningReasons.includes(item.reason)
  );
  if (codexRunning && !hasCurrentSafeReason) {
    return false;
  }
  const hasAfterExitReason = !codexRunning && cleanableItems.some((item) => item && item.reason === 'codex-not-running-and-allowlisted-orphan');
  if (!codexRunning && !hasPressure && !hasAfterExitReason) {
    return false;
  }

  const cooldownMinutes = codexRunning
    ? config.codexAutoCleanWhileRunningCooldownMinutes
    : config.codexScanIntervalSeconds / 60;
  const cooldownMs = Math.max(60_000, Number(cooldownMinutes || 1) * 60 * 1000);
  return now - lastCodexAutoClean >= cooldownMs;
}

async function autoCleanCodex(scan, now = Date.now()) {
  if (!shouldAutoCleanCodex(scan, now)) {
    return null;
  }

  const codexRunning = Boolean(scan.codex && scan.codex.running);
  const reason = codexRunning ? 'codex-auto-while-running' : 'codex-auto-after-exit';
  const allowedReasons = codexRunning ? codexAutoCleanWhileRunningReasons : [];
  const maxKills = codexRunning ? config.codexAutoCleanWhileRunningMaxKillsPerPass : 0;
  lastCodexAutoClean = now;
  codexAutoCleanInFlight = true;
  try {
    const result = await runEngine('codex-clean', reason, {
      codexDryRun: false,
      codexAllowedReasons: allowedReasons,
      codexMaxKillsPerPass: maxKills
    });
    recordCodexHistory(result, reason);
    lastCodexScan = 0;
    lastCodexScanResult = null;
    return result;
  } finally {
    codexAutoCleanInFlight = false;
  }
}

function positionWindow() {
  if (!win) return;
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor) || screen.getPrimaryDisplay();
  const area = display.workArea;
  const [width] = win.getSize();
  win.setPosition(area.x + area.width - width - 18, area.y + 18, false);
}

function showWidgetWindow() {
  if (!win || win.isDestroyed()) return;
  positionWindow();
  win.setSkipTaskbar(true);
  win.showInactive();
  win.setSkipTaskbar(true);
}

function createWindow() {
  win = new BrowserWindow({
    width: 240,
    height: 92,
    frame: false,
    resizable: false,
    movable: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    icon: TRAY_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer.html'));
  win.webContents.on('context-menu', () => showContextMenu());
  win.once('ready-to-show', () => {
    showWidgetWindow();
  });
}

function createDashboard() {
  if (dashboard && !dashboard.isDestroyed()) {
    dashboard.setSkipTaskbar(true);
    dashboard.show();
    dashboard.focus();
    return;
  }

  dashboard = new BrowserWindow({
    width: 780,
    height: 560,
    minWidth: 720,
    minHeight: 500,
    title: zh.settingsTitle,
    frame: false,
    show: false,
    skipTaskbar: true,
    backgroundColor: '#0f172a',
    icon: TRAY_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  dashboard.loadFile(path.join(__dirname, 'dashboard.html'));
  dashboard.once('ready-to-show', () => {
    dashboard.setSkipTaskbar(true);
    dashboard.show();
    dashboard.setSkipTaskbar(true);
  });
  dashboard.on('closed', () => {
    dashboard = null;
  });
}

function showContextMenu() {
  Menu.buildFromTemplate(createMenuTemplate()).popup({ window: win });
}

function createMenuTemplate() {
  const paused = Date.now() < pausedUntil;
  return [
    { label: zh.cleanNow, click: () => cleanNow('menu') },
    {
      label: paused ? zh.resume : zh.pause,
      click: () => {
        pausedUntil = paused ? 0 : Date.now() + 60 * 60 * 1000;
        if (win && !win.isDestroyed()) win.webContents.send('pause-state', pausedUntil);
        updateTrayMenu();
      }
    },
    { type: 'separator' },
    { label: zh.dashboard, click: () => createDashboard() },
    { label: win && win.isVisible() ? zh.hideWidget : zh.showWidget, click: () => toggleWindow() },
    { label: zh.logs, click: () => shell.openPath(LOG_DIR) },
    {
      label: zh.history,
      click: () => {
        if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, '[]\n', 'utf8');
        shell.openPath(HISTORY_FILE);
      }
    },
    { label: zh.config, click: () => shell.openPath(CONFIG_FILE) },
    { label: zh.exit, click: () => app.quit() }
  ];
}

function createTray() {
  const icon = nativeImage.createFromPath(TRAY_ICON);
  tray = new Tray(icon);
  tray.setToolTip('MemGuard');
  tray.on('click', createDashboard);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(createMenuTemplate()));
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    showWidgetWindow();
  }
  updateTrayMenu();
}

async function publishSnapshot() {
  if (!win || win.isDestroyed()) return;
  try {
    const snapshot = await runEngine('snapshot');
    snapshot.pausedUntil = pausedUntil || null;
    win.webContents.send('snapshot', snapshot);

    if (Date.now() < pausedUntil) {
      highCount = 0;
      return;
    }

    if (snapshot.usedPercent >= config.triggerPercent) {
      highCount += 1;
    } else {
      highCount = 0;
    }

    const now = Date.now();
    if (highCount >= config.consecutiveHighChecks && now - lastAutoTrim > config.cooldownMinutes * 60 * 1000) {
      lastAutoTrim = now;
      highCount = 0;
      const result = await runEngine('trim', 'auto');
      recordTrimHistory(result, 'auto');
      win.webContents.send('trim-result', result);
      if (Number(result.freedGB || 0) < 0.1) {
        lastAutoTrim = now + config.cooldownMinutes * 60 * 1000;
      }
      updateTrayMenu();
    }

    if (config.codexGuardEnabled) {
      try {
        const codex = await codexScan(false);
        await autoCleanCodex(codex, now);
      } catch {}
    }
  } catch (error) {
    win.webContents.send('engine-error', error.message);
  }
}

ipcMain.handle('trim-now', async () => cleanNow('manual'));
ipcMain.handle('codex-scan', async () => codexScan(true));
ipcMain.handle('codex-clean-dry-run', async () => codexClean('codex-dry-run', true));
ipcMain.handle('codex-clean', async () => codexClean('codex-manual', false));
ipcMain.handle('hide-window', () => {
  if (win && !win.isDestroyed()) win.hide();
});
ipcMain.handle('show-menu', () => showContextMenu());
ipcMain.handle('dashboard-state', async () => ({
  snapshot: await runEngine('snapshot'),
  config,
  history: readHistory(),
  pausedUntil
}));
ipcMain.handle('save-config', (_event, nextConfig) => saveConfig(nextConfig || {}));
ipcMain.handle('open-dashboard', () => createDashboard());
ipcMain.handle('open-logs', () => shell.openPath(LOG_DIR));
ipcMain.handle('open-history', () => {
  if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, '[]\n', 'utf8');
  return shell.openPath(HISTORY_FILE);
});
ipcMain.handle('open-config', () => shell.openPath(CONFIG_FILE));
ipcMain.handle('dashboard-window', (event, action) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target) return;
  if (action === 'minimize') target.minimize();
  if (action === 'close') target.close();
});

app.whenReady().then(async () => {
  app.setAppUserModelId('local.memguard.app');
  createWindow();
  createTray();
  try {
    if (config.trimOnStart) {
      const result = await runEngine('trim', 'startup');
      recordTrimHistory(result, 'startup');
      if (win) win.webContents.once('did-finish-load', () => win.webContents.send('trim-result', result));
    }
  } catch {}
  setInterval(publishSnapshot, config.checkSeconds * 1000);
  setTimeout(publishSnapshot, 1200);
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});
