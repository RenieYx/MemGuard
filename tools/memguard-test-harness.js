const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');

function requireRuntimeSupport() {
  if (typeof fetch !== 'function') {
    throw new Error('This smoke test requires a Node.js runtime with global fetch.');
  }
  if (typeof WebSocket !== 'function') {
    throw new Error('This smoke test requires a Node.js runtime with global WebSocket.');
  }
}

function getLaunchTarget(mode, commandName = 'smoke test') {
  if (mode === 'packed') {
    const exe = path.join(root, 'dist', 'win-unpacked', 'MemGuard.exe');
    if (!fs.existsSync(exe)) {
      throw new Error(`Packed MemGuard.exe not found. Run npm run pack before ${commandName}.`);
    }
    return {
      command: exe,
      args: [],
      cwd: path.dirname(exe)
    };
  }

  const electronBin = process.platform === 'win32'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(root, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) {
    throw new Error('Local Electron binary not found. Run npm install first.');
  }
  return {
    command: electronBin,
    args: [root],
    cwd: root
  };
}

function defaultConfig(overrides = {}) {
  return {
    triggerPercent: 99,
    minProcessMB: 180,
    cooldownMinutes: 240,
    checkSeconds: 60,
    adaptiveCheckIntervalEnabled: true,
    consecutiveHighChecks: 10,
    memoryMode: 'balanced',
    lowResourceMode: true,
    showWidgetOnStart: false,
    disableHardwareAcceleration: true,
    trimOnStart: false,
    historyLimit: 10,
    codexGuardEnabled: false,
    codexPolicyVersion: 3,
    codexAutoCleanAfterCodexExit: false,
    codexAutoCleanWhileRunning: false,
    codexCleanWhileRunning: 'report-only',
    codexStaleMinutes: 10,
    codexMaxMcpProcesses: 1000,
    codexCommitPressurePercent: 99,
    codexScanIntervalSeconds: 600,
    codexAutoCleanWhileRunningCooldownMinutes: 240,
    codexAutoCleanWhileRunningMaxKillsPerPass: 1,
    codexDryRunByDefault: true,
    codexKillAllowlist: [],
    ...overrides
  };
}

function createIsolatedDataDir(prefix, markerFileName) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(userDataDir, markerFileName), `${new Date().toISOString()}\n`, 'utf8');
  return userDataDir;
}

function writeIsolatedConfig(userDataDir, overrides = {}) {
  const dataDir = path.join(userDataDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const config = defaultConfig(overrides);
  fs.writeFileSync(path.join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/\//g, '\\');
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function waitForDebuggerTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      const browser = String(version && version.Browser || '').toLowerCase();
      const userAgent = String(version && version['User-Agent'] || '').toLowerCase();
      if (browser.includes('electron') || userAgent.includes('electron')) {
        return version;
      }
      lastError = new Error(`remote debugger is not Electron: ${JSON.stringify(version)}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }
  throw lastError || new Error('remote debugger did not become available');
}

async function waitForPage(port, suffix, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const pages = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const page = pages.find((item) => String(item.url || '').endsWith(suffix));
      if (page && page.webSocketDebuggerUrl) {
        return page;
      }
      lastError = new Error(`${suffix} page not found; pages=${pages.map((item) => item.url).join(',')}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw lastError || new Error(`${suffix} page did not open`);
}

function cdpCall(ws, id, method, params = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);

    function onMessage(event) {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      if (message.error) {
        reject(new Error(`${method}: ${message.error.message}`));
      } else {
        resolve(message.result || {});
      }
    }

    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function openWebSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('CDP WebSocket connection timed out'));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(ws);
    }, { once: true });
    ws.addEventListener('error', (error) => {
      clearTimeout(timer);
      reject(error && error.error ? error.error : error);
    }, { once: true });
  });
}

async function openPageSession(page, timeoutMs) {
  const ws = await openWebSocket(page.webSocketDebuggerUrl, Math.min(timeoutMs, 10000));
  let id = 1;
  await cdpCall(ws, id++, 'Runtime.enable');
  await cdpCall(ws, id++, 'Page.enable');
  return {
    call: (method, params = {}, callTimeoutMs = timeoutMs) => cdpCall(ws, id++, method, params, callTimeoutMs),
    close: () => {
      try {
        ws.close();
      } catch {}
    }
  };
}

async function evaluatePage(page, expression, timeoutMs, settleMs = 1000) {
  const session = await openPageSession(page, timeoutMs);
  try {
    await sleep(settleMs);
    const result = await session.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, timeoutMs);
    return result.result ? result.result.value : null;
  } finally {
    session.close();
  }
}

async function inspectPage(page, options, expression, settleMs = 1000) {
  const session = await openPageSession(page, options.timeoutMs);
  try {
    await sleep(settleMs);
    const result = await session.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, options.timeoutMs);
    const value = result.result ? result.result.value : null;
    if (options.screenshot) {
      const screenshot = await session.call('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false
      }, options.timeoutMs);
      fs.mkdirSync(path.dirname(path.resolve(options.screenshot)), { recursive: true });
      fs.writeFileSync(options.screenshot, Buffer.from(screenshot.data, 'base64'));
    }
    return value;
  } finally {
    session.close();
  }
}

function getProcessRow(pid) {
  if (process.platform !== 'win32') return null;
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue; if ($p) { $p | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress }`
  ], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0 || !String(result.stdout || '').trim()) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function ownsProcess(row, target, markerArgName, userDataDir) {
  if (!row) return false;
  const text = normalizeText(`${row.ExecutablePath || ''} ${row.CommandLine || ''}`);
  const command = normalizeText(target.command);
  const markerArg = normalizeText(`--${markerArgName}=${userDataDir}`);
  return text.includes(command) && text.includes(markerArg);
}

function stopTree(rootPid, target, markerArgName, userDataDir) {
  if (!Number.isInteger(Number(rootPid)) || Number(rootPid) <= 0) return;
  if (process.platform === 'win32') {
    const row = getProcessRow(rootPid);
    if (row && !ownsProcess(row, target, markerArgName, userDataDir)) {
      throw new Error(`Refusing to taskkill PID ${rootPid}; process ownership check failed.`);
    }
  }
  spawnSync('taskkill.exe', ['/PID', String(rootPid), '/T', '/F'], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true
  });
}

function findResidualProcesses(userDataDir) {
  if (process.platform !== 'win32') return [];
  const escaped = userDataDir.replace(/'/g, "''");
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$rows = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' }; $rows | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`
  ], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0 || !String(result.stdout || '').trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function canRemoveIsolatedDataDir(userDataDir, prefix, markerFileName) {
  const resolved = path.resolve(userDataDir);
  const tempRoot = path.resolve(os.tmpdir());
  const marker = path.join(resolved, markerFileName);
  return resolved.startsWith(tempRoot + path.sep)
    && path.basename(resolved).startsWith(prefix)
    && fs.existsSync(marker);
}

function startMemGuard({ target, userDataDir, markerArgName, port, openDashboard, extraArgs = [], extraArgsBeforeMarker = false, env = {} }) {
  const args = [
    ...target.args,
    ...(port ? [`--remote-debugging-port=${port}`] : []),
    ...(extraArgsBeforeMarker ? extraArgs : []),
    `--${markerArgName}=${userDataDir}`,
    ...(extraArgsBeforeMarker ? [] : extraArgs)
  ];
  return spawn(target.command, args, {
    cwd: target.cwd,
    env: {
      ...process.env,
      MEMGUARD_USER_DATA_DIR: userDataDir,
      MEMGUARD_SMOKE: '1',
      MEMGUARD_ALLOW_MULTI_INSTANCE: '1',
      MEMGUARD_OPEN_DASHBOARD: openDashboard ? '1' : '0',
      ELECTRON_ENABLE_LOGGING: '0',
      ...env
    },
    stdio: 'ignore',
    windowsHide: true
  });
}

async function cleanupRun({ child, target, markerArgName, userDataDir, keepDataDir, prefix, markerFileName }) {
  stopTree(child && child.pid, target, markerArgName, userDataDir);
  await sleep(500);
  const residualProcesses = findResidualProcesses(userDataDir);
  if (!keepDataDir) {
    if (!canRemoveIsolatedDataDir(userDataDir, prefix, markerFileName)) {
      throw new Error(`Refusing to delete non-smoke data directory: ${userDataDir}`);
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  if (residualProcesses.length) {
    throw new Error(`Smoke process residuals remain for ${userDataDir}: ${residualProcesses.map((row) => `${row.Name}#${row.ProcessId}`).join(', ')}`);
  }
}

module.exports = {
  root,
  requireRuntimeSupport,
  getLaunchTarget,
  defaultConfig,
  createIsolatedDataDir,
  writeIsolatedConfig,
  sleep,
  findFreePort,
  waitForDebuggerTarget,
  waitForPage,
  cdpCall,
  openWebSocket,
  openPageSession,
  evaluatePage,
  inspectPage,
  getProcessRow,
  ownsProcess,
  stopTree,
  findResidualProcesses,
  canRemoveIsolatedDataDir,
  startMemGuard,
  cleanupRun
};
