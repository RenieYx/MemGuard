const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, shell } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createFastSnapshot } = require('./system-snapshot');
const {
  shouldCountHighCheck,
  shouldAutoTrim,
  shouldSkipTrimAfterCodex
} = require('./auto-relief');

const ROOT = path.resolve(__dirname, '..');
const overrideUserData = process.env.MEMGUARD_USER_DATA_DIR;
if (overrideUserData) {
  app.setPath('userData', path.resolve(overrideUserData));
}
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
let codexScanInFlight = null;
let codexScanGeneration = 0;
let codexAutoCleanInFlight = false;
let publishSnapshotInFlight = false;
let snapshotTimer = null;
let lastSnapshotIntervalMs = 0;
let dashboardRevealTimer = null;
let engineQueue = Promise.resolve();
let lastSnapshotResult = null;
let lastSnapshotAt = 0;
let lastFullSnapshotAt = 0;
let fullSnapshotInFlight = null;
let snapshotGeneration = 0;
let lastSelfUsage = null;
let lastSelfUsageAt = 0;

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

const packaged = app.isPackaged;
const FULL_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('disable-http-cache');

const defaultConfig = {
  triggerPercent: 85,
  minProcessMB: 180,
  cooldownMinutes: 20,
  checkSeconds: 15,
  adaptiveCheckIntervalEnabled: true,
  consecutiveHighChecks: 2,
  memoryMode: 'aggressive',
  lowResourceMode: true,
  showWidgetOnStart: false,
  disableHardwareAcceleration: true,
  trimOnStart: false,
  historyLimit: 50,
  codexGuardEnabled: true,
  codexPolicyVersion: 3,
  codexAutoCleanAfterCodexExit: true,
  codexAutoCleanWhileRunning: true,
  codexCleanWhileRunning: 'allow-stale',
  codexStaleMinutes: 10,
  codexMaxMcpProcesses: 40,
  codexCommitPressurePercent: 85,
  codexScanIntervalSeconds: 60,
  codexAutoCleanWhileRunningCooldownMinutes: 3,
  codexAutoCleanWhileRunningMaxKillsPerPass: 48,
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
  'previous-codex-session-missing-parent-chain-while-running',
  'duplicate-desktop-app-server-tool'
];
const codexAggressiveAutoCleanWhileRunningReasons = [
  ...codexAutoCleanWhileRunningReasons,
  'allow-stale-orphan-while-codex-running'
];
const codexAutoCleanAfterExitReasons = [
  'codex-not-running-and-allowlisted-orphan'
];
const codexRescueReasons = [
  ...codexAggressiveAutoCleanWhileRunningReasons,
  ...codexAutoCleanAfterExitReasons
];

ensureDataFiles();
let config = loadConfig();
applyRuntimeFlags(config);

const allowAdditionalInstance = process.env.MEMGUARD_SMOKE === '1' && process.env.MEMGUARD_ALLOW_MULTI_INSTANCE === '1';
const gotLock = allowAdditionalInstance || app.requestSingleInstanceLock();
if (!gotLock) app.quit();

Menu.setApplicationMenu(null);

app.on('second-instance', () => {
  updateTrayMenu();
});

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function applyRuntimeFlags(loadedConfig) {
  if (loadedConfig && loadedConfig.disableHardwareAcceleration) {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu-compositing');
  }
}

function runEngine(mode, reason = 'manual', options = {}) {
  const task = () => new Promise((resolve, reject) => {
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
      '-MemoryMode', String(options.memoryMode || config.memoryMode || defaultConfig.memoryMode),
      '-CodexStaleMinutes', String(config.codexStaleMinutes),
      '-CodexMaxMcpProcesses', String(config.codexMaxMcpProcesses),
      '-CodexCommitPressurePercent', String(config.codexCommitPressurePercent),
      '-CodexCleanWhileRunning', String(options.codexCleanWhileRunning || config.codexCleanWhileRunning),
      '-CodexMaxKillsPerPass', mode === 'codex-clean' ? String(options.codexMaxKillsPerPass || 0) : '0',
      '-CodexAllowedReasonsJson', mode === 'codex-clean' ? JSON.stringify(options.codexAllowedReasons || []) : '[]',
      '-CodexDryRun', mode === 'codex-clean' ? String(codexDryRun) : 'true',
      '-CodexKillAllowlistJson', JSON.stringify(config.codexKillAllowlist || [])
    ];

    const timeout = options.timeoutMs || (mode === 'codex-clean' ? 90_000 : mode === 'codex-scan' ? 60_000 : 30_000);
    execFile(POWERSHELL, args, { windowsHide: true, cwd: ROOT, timeout }, (error, stdout, stderr) => {
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
  const run = engineQueue.then(task, task);
  engineQueue = run.catch(() => {});
  return run;
}

function writeAppLog(message) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date();
    const day = [
      stamp.getFullYear(),
      String(stamp.getMonth() + 1).padStart(2, '0'),
      String(stamp.getDate()).padStart(2, '0')
    ].join('');
    const time = [
      String(stamp.getFullYear()).padStart(4, '0'),
      String(stamp.getMonth() + 1).padStart(2, '0'),
      String(stamp.getDate()).padStart(2, '0')
    ].join('-') + ' ' + [
      String(stamp.getHours()).padStart(2, '0'),
      String(stamp.getMinutes()).padStart(2, '0'),
      String(stamp.getSeconds()).padStart(2, '0')
    ].join(':');
    fs.appendFileSync(path.join(LOG_DIR, `memguard-${day}.log`), `[${time}] ${message}\n`, 'utf8');
  } catch {}
}

function sendWidget(channel, ...args) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args);
  }
}

function isVisibleWindow(target) {
  return Boolean(target && !target.isDestroyed() && target.isVisible());
}

function hasVisibleUi() {
  return isVisibleWindow(win) || isVisibleWindow(dashboard);
}

function hasVisibleCodexUi() {
  return isVisibleWindow(dashboard);
}

function rememberSnapshot(snapshot, full = false) {
  if (!snapshot) return;
  if (full) {
    snapshotGeneration += 1;
  }
  lastSnapshotResult = snapshot;
  lastSnapshotAt = Date.now();
  if (full) {
    lastFullSnapshotAt = lastSnapshotAt;
  }
}

function fullSnapshot(reason = 'snapshot') {
  if (fullSnapshotInFlight) {
    return fullSnapshotInFlight;
  }
  const generation = snapshotGeneration;
  const run = runEngine('snapshot', reason)
    .then((snapshot) => {
      const stale = generation !== snapshotGeneration;
      if (!stale) {
        rememberSnapshot(snapshot, true);
      }
      return { snapshot, stale };
    })
    .finally(() => {
      if (fullSnapshotInFlight === run) {
        fullSnapshotInFlight = null;
      }
    });
  fullSnapshotInFlight = run;
  return run;
}

async function getSnapshot(options = {}) {
  const maxAgeMs = Number(options.maxAgeMs || 0);
  const fast = options.fast !== false;
  const now = Date.now();
  if (maxAgeMs > 0 && lastSnapshotResult && now - lastSnapshotAt <= maxAgeMs) {
    return { ...lastSnapshotResult };
  }
  const needsFullSnapshot = !lastSnapshotResult
    || lastSnapshotResult.commitPercent == null
    || now - lastFullSnapshotAt >= Number(options.fullMaxAgeMs || FULL_SNAPSHOT_MAX_AGE_MS);
  if (fast && !needsFullSnapshot) {
    const snapshot = createFastSnapshot({
      dataDir: DATA_DIR,
      lastSnapshot: lastSnapshotResult,
      memoryMode: config.memoryMode || defaultConfig.memoryMode
    });
    rememberSnapshot(snapshot);
    return { ...snapshot };
  }
  try {
    const result = await fullSnapshot(options.reason || 'snapshot');
    const snapshot = result.stale && lastSnapshotResult ? lastSnapshotResult : result.snapshot;
    return { ...snapshot };
  } catch (error) {
    if (!fast || !lastSnapshotResult) {
      throw error;
    }
    writeAppLog(`Full snapshot fallback to fast snapshot: ${error.message}`);
    const snapshot = createFastSnapshot({
      dataDir: DATA_DIR,
      lastSnapshot: lastSnapshotResult,
      memoryMode: config.memoryMode || defaultConfig.memoryMode
    });
    rememberSnapshot(snapshot);
    return { ...snapshot };
  }
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
    merged.memoryMode = defaultConfig.memoryMode;
    merged.codexAutoCleanWhileRunning = true;
    merged.codexCleanWhileRunning = defaultConfig.codexCleanWhileRunning;
    merged.codexAutoCleanWhileRunningCooldownMinutes = defaultConfig.codexAutoCleanWhileRunningCooldownMinutes;
    merged.codexAutoCleanWhileRunningMaxKillsPerPass = defaultConfig.codexAutoCleanWhileRunningMaxKillsPerPass;
    merged.codexKillAllowlist = mergeAllowlists(loadedConfig ? loadedConfig.codexKillAllowlist : []);
  }
  return merged;
}

function saveConfig(nextConfig) {
  const source = { ...defaultConfig, ...config, ...(nextConfig || {}) };
  const normalized = {
    ...defaultConfig,
    ...source,
    triggerPercent: clampNumber(source.triggerPercent, 50, 98, defaultConfig.triggerPercent),
    minProcessMB: clampNumber(source.minProcessMB, 50, 2048, defaultConfig.minProcessMB),
    cooldownMinutes: clampNumber(source.cooldownMinutes, 1, 240, defaultConfig.cooldownMinutes),
    checkSeconds: clampNumber(source.checkSeconds, 5, 300, defaultConfig.checkSeconds),
    adaptiveCheckIntervalEnabled: source.adaptiveCheckIntervalEnabled == null
      ? defaultConfig.adaptiveCheckIntervalEnabled
      : Boolean(source.adaptiveCheckIntervalEnabled),
    consecutiveHighChecks: clampNumber(source.consecutiveHighChecks, 1, 10, defaultConfig.consecutiveHighChecks),
    historyLimit: clampNumber(source.historyLimit, 10, 500, defaultConfig.historyLimit),
    lowResourceMode: Boolean(source.lowResourceMode),
    showWidgetOnStart: Boolean(source.showWidgetOnStart),
    disableHardwareAcceleration: Boolean(source.disableHardwareAcceleration),
    trimOnStart: Boolean(source.trimOnStart),
    codexGuardEnabled: Boolean(source.codexGuardEnabled),
    codexPolicyVersion: defaultConfig.codexPolicyVersion,
    memoryMode: normalizeChoice(source.memoryMode, ['balanced', 'aggressive'], defaultConfig.memoryMode),
    codexAutoCleanAfterCodexExit: Boolean(source.codexAutoCleanAfterCodexExit),
    codexAutoCleanWhileRunning: Boolean(source.codexAutoCleanWhileRunning),
    codexCleanWhileRunning: normalizeChoice(source.codexCleanWhileRunning, ['current-safe', 'orphan-only', 'report-only', 'allow-stale'], defaultConfig.codexCleanWhileRunning),
    codexStaleMinutes: clampNumber(source.codexStaleMinutes, 1, 240, defaultConfig.codexStaleMinutes),
    codexMaxMcpProcesses: clampNumber(source.codexMaxMcpProcesses, 5, 1000, defaultConfig.codexMaxMcpProcesses),
    codexCommitPressurePercent: clampNumber(source.codexCommitPressurePercent, 50, 99, defaultConfig.codexCommitPressurePercent),
    codexScanIntervalSeconds: clampNumber(source.codexScanIntervalSeconds, 15, 600, defaultConfig.codexScanIntervalSeconds),
    codexAutoCleanWhileRunningCooldownMinutes: clampNumber(source.codexAutoCleanWhileRunningCooldownMinutes, 1, 240, defaultConfig.codexAutoCleanWhileRunningCooldownMinutes),
    codexAutoCleanWhileRunningMaxKillsPerPass: clampNumber(source.codexAutoCleanWhileRunningMaxKillsPerPass, 1, 100, defaultConfig.codexAutoCleanWhileRunningMaxKillsPerPass),
    codexDryRunByDefault: Boolean(source.codexDryRunByDefault),
    codexKillAllowlist: normalizeAllowlist(source.codexKillAllowlist)
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(normalized, null, 2), 'utf8');
  config = normalized;
  restartSnapshotTimer();
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
  sendWidget('cleaning-state', true);
  try {
    const result = await runEngine('trim', reason);
    rememberSnapshot(result && result.after ? result.after : null, true);
    recordTrimHistory(result, reason);
    sendWidget('trim-result', result);
    updateTrayMenu();
    return result;
  } catch (error) {
    sendWidget('engine-error', error.message);
    writeAppLog(`Trim error: ${error.message}`);
    return null;
  } finally {
    sendWidget('cleaning-state', false);
  }
}

async function trimPlan(reason = 'manual-plan') {
  return runEngine('trim-plan', reason, {
    timeoutMs: 45_000
  });
}

async function codexScan(force = true) {
  const now = Date.now();
  const intervalMs = codexScanIntervalMs();
  if (!force && lastCodexScanResult && now - lastCodexScan < intervalMs) {
    return lastCodexScanResult;
  }
  if (!force && codexScanInFlight) {
    return codexScanInFlight;
  }
  const startedAt = Date.now();
  const generation = codexScanGeneration;
  const run = runEngine('codex-scan', 'scan')
    .then((result) => {
      if (result && result.snapshot) {
        rememberSnapshot(result.snapshot, true);
      }
      if (generation === codexScanGeneration && (codexScanInFlight === run || force)) {
        lastCodexScan = startedAt;
        lastCodexScanResult = result;
      }
      return result;
    })
    .finally(() => {
      if (codexScanInFlight === run) {
        codexScanInFlight = null;
      }
    });
  if (!force) {
    codexScanInFlight = run;
  }
  return run;
}

function invalidateCodexScanCache() {
  lastCodexScan = 0;
  lastCodexScanResult = null;
  codexScanInFlight = null;
  codexScanGeneration += 1;
}

function codexScanIntervalMs(snapshot = lastSnapshotResult) {
  const baseMs = Math.max(15, Number(config.codexScanIntervalSeconds || defaultConfig.codexScanIntervalSeconds)) * 1000;
  const pressureLevel = snapshot && snapshot.pressureLevel ? snapshot.pressureLevel : 'normal';
  const pressureActive = ['watch', 'pressure', 'critical'].includes(pressureLevel)
    || Number(snapshot && snapshot.usedPercent || 0) >= Number(config.triggerPercent || defaultConfig.triggerPercent);
  if (!config.lowResourceMode || pressureActive || hasVisibleCodexUi()) {
    return baseMs;
  }
  return Math.min(5 * 60 * 1000, baseMs * 4);
}

function getCodexScanCache() {
  if (!lastCodexScanResult || !lastCodexScan) {
    return null;
  }
  const ageMs = Date.now() - lastCodexScan;
  return {
    result: lastCodexScanResult,
    scannedAt: new Date(lastCodexScan).toISOString(),
    ageSeconds: Math.max(0, Math.round(ageMs / 1000)),
    freshForSeconds: Math.max(0, Math.round((codexScanIntervalMs() - ageMs) / 1000))
  };
}

function getSelfUsage(maxAgeMs = 15_000) {
  const now = Date.now();
  if (lastSelfUsage && now - lastSelfUsageAt <= maxAgeMs) {
    return lastSelfUsage;
  }
  try {
    const metrics = app.getAppMetrics();
    const byType = {};
    for (const metric of metrics) {
      const type = normalizeMetricType(metric);
      if (!byType[type]) byType[type] = { count: 0, workingSetMB: 0, privateMB: 0 };
      byType[type].count += 1;
      byType[type].workingSetMB += kbToMB(metric.memory && metric.memory.workingSetSize);
      byType[type].privateMB += kbToMB(metric.memory && metric.memory.privateBytes);
    }
    for (const value of Object.values(byType)) {
      value.workingSetMB = roundMB(value.workingSetMB);
      value.privateMB = roundMB(value.privateMB);
    }
    lastSelfUsage = {
      processCount: metrics.length,
      totalWorkingSetMB: roundMB(metrics.reduce((sum, metric) => sum + kbToMB(metric.memory && metric.memory.workingSetSize), 0)),
      totalPrivateMB: roundMB(metrics.reduce((sum, metric) => sum + kbToMB(metric.memory && metric.memory.privateBytes), 0)),
      byType,
      sampledAt: new Date().toISOString()
    };
  } catch (error) {
    lastSelfUsage = {
      error: error.message,
      sampledAt: new Date().toISOString()
    };
    writeAppLog(`Self usage error: ${error.message}`);
  }
  lastSelfUsageAt = now;
  return lastSelfUsage;
}

function normalizeMetricType(metric) {
  const type = String(metric && metric.type || '').toLowerCase();
  const name = String(metric && metric.name || '').toLowerCase();
  if (type === 'browser') return 'browser-main';
  if (type === 'gpu') return 'gpu';
  if (type === 'renderer') return 'renderer';
  if (type === 'utility') return name.includes('network') ? 'utility-network' : 'utility';
  return type || 'other';
}

function kbToMB(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number / 1024 : 0;
}

function roundMB(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

async function codexClean(reason = 'codex-manual', dryRun = config.codexDryRunByDefault) {
  const result = await runEngine('codex-clean', reason, { codexDryRun: dryRun });
  if (result && result.after && result.after.snapshot) {
    rememberSnapshot(result.after.snapshot, true);
  }
  invalidateCodexScanCache();
  recordCodexHistory(result, reason);
  return result;
}

async function rescueNow(reason = 'rescue') {
  sendWidget('cleaning-state', true);
  let codex = null;
  let trim = null;
  try {
    let codexError = null;
    try {
      codex = await runEngine('codex-clean', 'emergency-previous-session-orphans', {
        codexDryRun: false,
        codexAllowedReasons: codexRescueReasons,
        codexMaxKillsPerPass: Math.max(48, Number(config.codexAutoCleanWhileRunningMaxKillsPerPass || 48)),
        codexCleanWhileRunning: 'allow-stale',
        memoryMode: 'aggressive',
        timeoutMs: 120_000
      });
      recordCodexHistory(codex, reason);
    } catch (error) {
      codexError = error;
      writeAppLog(`Rescue Codex clean error: ${error.message}`);
    }

    trim = await runEngine('rescue', reason, {
      memoryMode: 'aggressive',
      timeoutMs: 90_000
    });
    if (trim && trim.after) {
      rememberSnapshot(trim.after, true);
      recordTrimHistory(trim, reason);
      sendWidget('trim-result', trim);
    }
    invalidateCodexScanCache();
    updateTrayMenu();
    return {
      codex,
      codexError: codexError ? codexError.message : null,
      trim,
      after: trim ? trim.after : null
    };
  } catch (error) {
    sendWidget('engine-error', error.message);
    throw error;
  } finally {
    sendWidget('cleaning-state', false);
  }
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
  const runningReasons = config.memoryMode === 'aggressive'
    ? codexAggressiveAutoCleanWhileRunningReasons
    : codexAutoCleanWhileRunningReasons;
  const hasCurrentSafeReason = cleanableItems.some((item) => item && runningReasons.includes(item.reason));
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
  const cooldownMs = hasPressure
    ? Math.min(60_000, Math.max(15_000, Number(cooldownMinutes || 1) * 60 * 1000))
    : Math.max(60_000, Number(cooldownMinutes || 1) * 60 * 1000);
  return now - lastCodexAutoClean >= cooldownMs;
}

async function autoCleanCodex(scan, now = Date.now()) {
  if (!shouldAutoCleanCodex(scan, now)) {
    return null;
  }

  const codexRunning = Boolean(scan.codex && scan.codex.running);
  const reason = codexRunning ? 'codex-auto-while-running' : 'codex-auto-after-exit';
  const allowedReasons = codexRunning && config.memoryMode === 'aggressive'
    ? codexAggressiveAutoCleanWhileRunningReasons
    : codexRunning ? codexAutoCleanWhileRunningReasons : codexAutoCleanAfterExitReasons;
  const maxKills = codexRunning ? config.codexAutoCleanWhileRunningMaxKillsPerPass : 100;
  lastCodexAutoClean = now;
  codexAutoCleanInFlight = true;
  try {
    const result = await runEngine('codex-clean', reason, {
      codexDryRun: false,
      codexAllowedReasons: allowedReasons,
      codexMaxKillsPerPass: maxKills
    });
    if (result && result.after && result.after.snapshot) {
      rememberSnapshot(result.after.snapshot, true);
    }
    recordCodexHistory(result, reason);
    invalidateCodexScanCache();
    return result;
  } catch (error) {
    const retryBackoffMs = Math.min(30_000, Math.max(5_000, Number(config.codexScanIntervalSeconds || defaultConfig.codexScanIntervalSeconds) * 1000));
    lastCodexAutoClean = now - retryBackoffMs;
    throw error;
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
  if (!win || win.isDestroyed()) {
    createWindow(true);
    return;
  }
  if (!win || win.isDestroyed()) return;
  win.setSize(244, 96, false);
  positionWindow();
  win.setSkipTaskbar(true);
  win.showInactive();
  win.setSkipTaskbar(true);
  updateTrayMenu();
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) {
      positionWindow();
      win.show();
      win.setSkipTaskbar(true);
    }
    updateTrayMenu();
  }, 120);
}

function hideWidgetWindow() {
  if (!win || win.isDestroyed()) return;
  if (config.lowResourceMode) {
    win.destroy();
  } else {
    win.hide();
  }
  updateTrayMenu();
}

function revealDashboard() {
  if (!dashboard || dashboard.isDestroyed()) return;
  if (dashboardRevealTimer) {
    clearTimeout(dashboardRevealTimer);
    dashboardRevealTimer = null;
  }
  if (dashboard.isMinimized()) dashboard.restore();
  dashboard.show();
  dashboard.focus();
}

function createWindow(showWhenReady = false) {
  if (win && !win.isDestroyed()) {
    if (showWhenReady) showWidgetWindow();
    return;
  }
  let revealed = false;
  const revealWidget = () => {
    if (!showWhenReady || revealed) return;
    revealed = true;
    showWidgetWindow();
  };
  win = new BrowserWindow({
    width: 244,
    height: 96,
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
      backgroundThrottling: true,
      devTools: !packaged,
      spellcheck: false,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer.html')).then(() => {
    setTimeout(revealWidget, 120);
  }).catch((error) => {
    writeAppLog(`Widget load error: ${error.message}`);
  });
  win.webContents.on('context-menu', () => showContextMenu());
  win.webContents.once('did-finish-load', () => setTimeout(revealWidget, 60));
  win.once('ready-to-show', revealWidget);
  win.on('closed', () => {
    win = null;
    updateTrayMenu();
  });
}

function createDashboard() {
  if (dashboard && !dashboard.isDestroyed()) {
    revealDashboard();
    return;
  }

  dashboard = new BrowserWindow({
    width: 920,
    height: 620,
    minWidth: 860,
    minHeight: 500,
    title: zh.settingsTitle,
    frame: false,
    show: false,
    skipTaskbar: false,
    backgroundColor: '#0f172a',
    icon: TRAY_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: true,
      devTools: !packaged,
      spellcheck: false,
      nodeIntegration: false
    }
  });

  dashboard.once('ready-to-show', revealDashboard);
  dashboard.webContents.once('did-finish-load', revealDashboard);
  dashboard.loadFile(path.join(__dirname, 'dashboard.html')).then(revealDashboard).catch((error) => {
    writeAppLog(`Dashboard load error: ${error.message}`);
  });
  dashboardRevealTimer = setTimeout(revealDashboard, 1500);
  dashboard.on('closed', () => {
    if (dashboardRevealTimer) {
      clearTimeout(dashboardRevealTimer);
      dashboardRevealTimer = null;
    }
    dashboard = null;
  });
}

function showContextMenu() {
  const popupOptions = win && !win.isDestroyed() ? { window: win } : {};
  Menu.buildFromTemplate(createMenuTemplate()).popup(popupOptions);
}

function createMenuTemplate() {
  const paused = Date.now() < pausedUntil;
  return [
    { label: zh.cleanNow, click: () => cleanNow('menu') },
    {
      label: paused ? zh.resume : zh.pause,
      click: () => {
        pausedUntil = paused ? 0 : Date.now() + 60 * 60 * 1000;
        sendWidget('pause-state', pausedUntil);
        updateTrayMenu();
      }
    },
    { type: 'separator' },
    { label: zh.dashboard, click: () => createDashboard() },
    { label: isVisibleWindow(win) ? zh.hideWidget : zh.showWidget, click: () => toggleWindow() },
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
  tray.on('click', () => tray.popUpContextMenu());
  tray.on('double-click', createDashboard);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(createMenuTemplate()));
}

function toggleWindow() {
  if (!win || win.isDestroyed()) {
    showWidgetWindow();
    return;
  }
  if (win.isVisible()) {
    hideWidgetWindow();
  } else {
    showWidgetWindow();
  }
  updateTrayMenu();
}

async function publishSnapshot() {
  if (publishSnapshotInFlight) {
    writeAppLog('Snapshot skipped: previous publishSnapshot still running');
    scheduleNextSnapshot();
    return;
  }
  publishSnapshotInFlight = true;
  try {
    const snapshot = await getSnapshot({ reason: 'snapshot', fast: true });
    snapshot.pausedUntil = pausedUntil || null;
    sendWidget('snapshot', snapshot);

    if (Date.now() < pausedUntil) {
      highCount = 0;
      return;
    }

    if (shouldCountHighCheck(snapshot, config)) {
      highCount += 1;
    } else {
      highCount = 0;
    }

    const now = Date.now();
    let trimSnapshot = snapshot;
    if (config.codexGuardEnabled) {
      try {
        const codex = await codexScan(false);
        const codexCleanResult = await autoCleanCodex(codex, now);
        const afterCodexSnapshot = codexCleanResult && codexCleanResult.after && codexCleanResult.after.snapshot
          ? codexCleanResult.after.snapshot
          : null;
        if (afterCodexSnapshot) {
          trimSnapshot = afterCodexSnapshot;
          if (shouldSkipTrimAfterCodex({ snapshot: afterCodexSnapshot, config })) {
            highCount = 0;
            writeAppLog(`Auto trim skipped: pressure relieved after Codex clean; level=${afterCodexSnapshot.pressureLevel || 'normal'} used=${afterCodexSnapshot.usedPercent}% free=${afterCodexSnapshot.freeGB}GB`);
          }
        }
      } catch (error) {
        writeAppLog(`Codex guard error: ${error.message}`);
      }
    }

    if (shouldAutoTrim({ snapshot: trimSnapshot, config, highCount, lastAutoTrim, now })) {
      lastAutoTrim = now;
      highCount = 0;
      const result = await runEngine('trim', 'auto');
      rememberSnapshot(result && result.after ? result.after : null, true);
      recordTrimHistory(result, 'auto');
      sendWidget('trim-result', result);
      if (Number(result.freedGB || 0) < 0.1 && snapshot.usedPercent < 90 && snapshot.commitPercent < config.codexCommitPressurePercent) {
        lastAutoTrim = now + config.cooldownMinutes * 60 * 1000;
      }
      updateTrayMenu();
    }
  } catch (error) {
    writeAppLog(`Snapshot error: ${error.message}`);
    sendWidget('engine-error', error.message);
  } finally {
    publishSnapshotInFlight = false;
    scheduleNextSnapshot(lastSnapshotResult);
  }
}

function snapshotIntervalMs(snapshot = lastSnapshotResult) {
  const baseSeconds = Math.max(5, Number(config.checkSeconds || defaultConfig.checkSeconds));
  if (!config.adaptiveCheckIntervalEnabled) {
    return baseSeconds * 1000;
  }
  const level = snapshot && snapshot.pressureLevel ? snapshot.pressureLevel : 'normal';
  if (level === 'critical') return 5_000;
  if (level === 'pressure') return Math.max(8, Math.floor(baseSeconds / 2)) * 1000;
  if (level === 'watch') return baseSeconds * 1000;
  return Math.min(90, Math.max(baseSeconds, baseSeconds * 2)) * 1000;
}

function scheduleNextSnapshot(snapshot = lastSnapshotResult) {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  const intervalMs = snapshotIntervalMs(snapshot);
  lastSnapshotIntervalMs = intervalMs;
  scheduleSnapshotIn(intervalMs);
}

function scheduleSnapshotIn(intervalMs) {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  lastSnapshotIntervalMs = intervalMs;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    publishSnapshot();
  }, intervalMs);
}

function restartSnapshotTimer() {
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
  scheduleNextSnapshot();
}

ipcMain.handle('trim-now', async () => cleanNow('manual'));
ipcMain.handle('trim-plan', async () => trimPlan('manual-plan'));
ipcMain.handle('codex-scan', async (_event, force = true) => codexScan(Boolean(force)));
ipcMain.handle('codex-clean-dry-run', async () => codexClean('codex-dry-run', true));
ipcMain.handle('codex-clean', async () => codexClean('codex-manual'));
ipcMain.handle('rescue-now', async () => rescueNow('rescue'));
ipcMain.handle('hide-window', () => {
  hideWidgetWindow();
});
ipcMain.handle('show-menu', () => showContextMenu());
ipcMain.handle('widget-state', async () => {
  const snapshot = await getSnapshot({ reason: 'widget-state', maxAgeMs: 4000, fast: true });
  snapshot.pausedUntil = pausedUntil || null;
  return snapshot;
});
ipcMain.handle('dashboard-state', async () => ({
  snapshot: await getSnapshot({ reason: 'dashboard-state', maxAgeMs: 4000, fast: true }),
  config,
  history: readHistory(),
  pausedUntil,
  nextSnapshotIntervalSeconds: Math.round(lastSnapshotIntervalMs / 1000),
  selfUsage: getSelfUsage(),
  codexScanCache: getCodexScanCache()
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
  createTray();
  if (!config.lowResourceMode || config.showWidgetOnStart) {
    createWindow(Boolean(config.showWidgetOnStart));
  }
  if (process.env.MEMGUARD_OPEN_DASHBOARD === '1') {
    createDashboard();
  }
  try {
    if (config.trimOnStart) {
      const result = await runEngine('trim', 'startup');
      recordTrimHistory(result, 'startup');
      if (win) win.webContents.once('did-finish-load', () => sendWidget('trim-result', result));
    }
  } catch (error) {
    writeAppLog(`Startup trim error: ${error.message}`);
  }
  scheduleSnapshotIn(1200);
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('before-quit', () => {
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
});
