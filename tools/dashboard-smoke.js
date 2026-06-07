const path = require('path');
const {
  root,
  requireRuntimeSupport,
  getLaunchTarget,
  createIsolatedDataDir,
  writeIsolatedConfig,
  findFreePort,
  waitForDebuggerTarget,
  waitForPage,
  inspectPage,
  getProcessRow,
  ownsProcess,
  startMemGuard,
  cleanupRun
} = require('./memguard-test-harness');

const markerFileName = '.memguard-dashboard-smoke';
const markerArgName = 'memguard-dashboard-smoke-data-dir';
const dataDirPrefix = 'memguard-dashboard-smoke-';
const unsavedText = '\u672a\u4fdd\u5b58';
const restartText = '\u91cd\u542f';

function parseArgs(argv) {
  const options = {
    mode: 'packed',
    timeoutMs: 30000,
    port: 0,
    json: false,
    keepDataDir: false,
    screenshot: ''
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--mode') {
      options.mode = argv[++index] || options.mode;
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(argv[++index] || options.timeoutMs);
    } else if (arg === '--port') {
      options.port = Number(argv[++index] || 0);
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--keep-data-dir') {
      options.keepDataDir = true;
    } else if (arg === '--screenshot') {
      options.screenshot = argv[++index] || '';
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['packed', 'dev'].includes(options.mode)) {
    throw new Error('--mode must be packed or dev');
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 10000) {
    throw new Error('--timeout-ms must be at least 10000');
  }
  if (options.port && (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535)) {
    throw new Error('--port must be between 1024 and 65535');
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node tools/dashboard-smoke.js [options]

Options:
  --mode <packed|dev>       Launch dist/win-unpacked/MemGuard.exe or local Electron, default packed
  --timeout-ms <ms>         Max wait for dashboard and IPC checks, default 30000
  --port <port>             Remote debugging port; default picks a free local port
  --json                    Print JSON only
  --keep-data-dir           Keep the isolated temporary userData directory
  --screenshot <path>       Save a dashboard screenshot to this path
`);
}

function dashboardExpression() {
  return `window.memguard.getDashboardState().then(async (state) => {
    const ids = [
      'actionStatus',
      'trimPlanStatus',
      'pressureActionBar',
      'pressureActionTitle',
      'pressureActionDetail',
      'pressureActionHint',
      'selfWorkingSet',
      'selfUsageDetail',
      'pressureLevel',
      'nextSnapshotInterval',
      'applyLowResourceButton',
      'trimPlanButton',
      'rescueButton',
      'codexStatus',
      'settingsForm'
    ];
    const missing = ids.filter((item) => !document.getElementById(item));
    const field = document.querySelector('[name="disableHardwareAcceleration"]');
    if (field) {
      field.checked = !field.checked;
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
    let rescueConfirmMessage = '';
    const originalConfirm = window.confirm;
    window.confirm = (message) => {
      rescueConfirmMessage = String(message || '');
      return false;
    };
    try {
      document.getElementById('rescueButton')?.click();
      const deadline = Date.now() + 10000;
      while (!rescueConfirmMessage && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      window.confirm = originalConfirm;
    }
    return {
      title: document.title,
      missing,
      saveStateAfterDirty: document.getElementById('saveState')?.textContent?.trim() || '',
      actionStatusClass: document.getElementById('actionStatus')?.className || '',
      actionStatusText: document.getElementById('actionStatus')?.textContent?.trim() || '',
      codexStatusText: document.getElementById('codexStatus')?.textContent?.trim() || '',
      pressureActionClass: document.getElementById('pressureActionBar')?.className || '',
      pressureActionLabel: document.getElementById('pressureActionLabel')?.textContent?.trim() || '',
      pressureActionTitle: document.getElementById('pressureActionTitle')?.textContent?.trim() || '',
      pressureActionDetail: document.getElementById('pressureActionDetail')?.textContent?.trim() || '',
      pressureActionHint: document.getElementById('pressureActionHint')?.textContent?.trim() || '',
      recommendedButtonCount: document.querySelectorAll('.button-recommended').length,
      bodyLength: document.body.innerText.length,
      rescueConfirmMessage,
      rescueButtonDisabledAfterCancel: document.getElementById('rescueButton')?.disabled === true,
      snapshot: {
        usedPercent: state.snapshot && state.snapshot.usedPercent,
        commitPercent: state.snapshot && state.snapshot.commitPercent,
        processCount: state.snapshot && state.snapshot.processCount,
        pressureLevel: state.snapshot && state.snapshot.pressureLevel,
        source: state.snapshot && state.snapshot.source
      },
      selfUsage: {
        processCount: state.selfUsage && state.selfUsage.processCount,
        totalWorkingSetMB: state.selfUsage && state.selfUsage.totalWorkingSetMB
      },
      nextSnapshotIntervalSeconds: state.nextSnapshotIntervalSeconds,
      hasCodexScanCacheField: Object.prototype.hasOwnProperty.call(state, 'codexScanCache')
    };
  })`;
}

function assertSmoke(condition, message, failures) {
  if (!condition) failures.push(message);
}

function validateResult(result) {
  const failures = [];
  assertSmoke(result && typeof result === 'object', 'dashboard inspection returned no result', failures);
  if (!result) return failures;

  assertSmoke(String(result.title || '').includes('MemGuard'), 'dashboard title should include MemGuard', failures);
  assertSmoke(Array.isArray(result.missing) && result.missing.length === 0, `missing dashboard elements: ${(result.missing || []).join(', ')}`, failures);
  assertSmoke(Number(result.bodyLength || 0) > 200, 'dashboard body text is unexpectedly short', failures);
  assertSmoke(String(result.saveStateAfterDirty || '').includes(unsavedText), 'dirty setting should show an unsaved warning', failures);
  assertSmoke(String(result.saveStateAfterDirty || '').includes(restartText), 'hardware acceleration change should show restart hint', failures);
  assertSmoke(!String(result.codexStatusText || '').includes('\u6b63\u5728\u626b\u63cf'), 'dashboard should not auto-start Codex scan on first load', failures);
  assertSmoke(result.hasCodexScanCacheField === true, 'dashboard state should expose codexScanCache without forcing a scan', failures);
  assertSmoke(String(result.pressureActionClass || '').includes('pressure-action-'), 'pressure action bar should expose pressure-level class', failures);
  assertSmoke(String(result.pressureActionLabel || '') === '\u5904\u7f6e\u5efa\u8bae', 'pressure action label should be 处置建议', failures);
  assertSmoke(Number(String(result.pressureActionTitle || '').length) > 3, 'pressure action title should render a recommendation', failures);
  assertSmoke(!String(result.pressureActionTitle || '').includes('\u6b63\u5728\u8bfb\u53d6'), 'pressure action title should not stay on the loading placeholder', failures);
  assertSmoke(String(result.pressureActionDetail || '').includes('Codex'), 'pressure action detail should include Codex context', failures);
  assertSmoke(String(result.pressureActionHint || '').includes('\u63a8\u8350'), 'pressure action hint should name the recommended action', failures);
  assertSmoke(Number(result.recommendedButtonCount || 0) <= 2, 'pressure action should not highlight more than two command buttons', failures);
  assertSmoke(String(result.rescueConfirmMessage || '').includes('\u5f53\u524d\u538b\u529b'), 'rescue confirmation should include current pressure summary', failures);
  assertSmoke(String(result.rescueConfirmMessage || '').includes('Codex \u5019\u9009'), 'rescue confirmation should include Codex candidate summary', failures);
  assertSmoke(String(result.rescueConfirmMessage || '').includes('dev server'), 'rescue confirmation should mention protected dev servers', failures);
  assertSmoke(String(result.actionStatusText || '').includes('\u5df2\u53d6\u6d88\u5f3a\u5236\u62a2\u6551'), 'cancelled rescue should show a cancelled status', failures);
  assertSmoke(result.rescueButtonDisabledAfterCancel === false, 'rescue button should be re-enabled after cancelling confirmation', failures);
  assertSmoke(Number.isFinite(Number(result.snapshot && result.snapshot.usedPercent)), 'snapshot.usedPercent must be numeric', failures);
  assertSmoke(result.snapshot && result.snapshot.commitPercent != null, 'snapshot.commitPercent must be present after full snapshot fallback', failures);
  assertSmoke(result.snapshot && result.snapshot.processCount != null, 'snapshot.processCount must be present after full snapshot fallback', failures);
  assertSmoke(Number(result.selfUsage && result.selfUsage.processCount) > 0, 'self usage process count must be greater than zero', failures);
  assertSmoke(Number(result.selfUsage && result.selfUsage.totalWorkingSetMB) > 0, 'self usage working set must be greater than zero', failures);
  return failures;
}

async function runSmoke(options) {
  requireRuntimeSupport();
  const target = getLaunchTarget(options.mode, 'npm run smoke:dashboard');
  const port = options.port || await findFreePort();
  const userDataDir = createIsolatedDataDir(dataDirPrefix, markerFileName);
  writeIsolatedConfig(userDataDir);
  const child = startMemGuard({
    target,
    userDataDir,
    markerArgName,
    port,
    openDashboard: true
  });

  let exited = false;
  let exitCode = null;
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
  });

  try {
    await waitForDebuggerTarget(port, Math.min(options.timeoutMs, 15000));
    const row = getProcessRow(child.pid);
    if (row && !ownsProcess(row, target, markerArgName, userDataDir)) {
      throw new Error(`Smoke process ownership check failed for PID ${child.pid}.`);
    }
    const page = await waitForPage(port, '/dashboard.html', options.timeoutMs);
    if (exited) {
      throw new Error(`MemGuard exited before inspection with code ${exitCode}`);
    }
    const result = await inspectPage(page, options, dashboardExpression(), 1200);
    const failures = validateResult(result);
    return {
      ok: failures.length === 0,
      failures,
      mode: options.mode,
      port,
      pid: child.pid,
      userDataDir: options.keepDataDir ? userDataDir : null,
      screenshot: options.screenshot || null,
      result
    };
  } finally {
    await cleanupRun({
      child,
      target,
      markerArgName,
      userDataDir,
      keepDataDir: options.keepDataDir,
      prefix: dataDirPrefix,
      markerFileName
    });
  }
}

function printResult(report, json) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log('\nMemGuard dashboard smoke');
  console.log(`Mode: ${report.mode}`);
  console.log(`Result: ${report.ok ? 'PASS' : 'FAIL'}`);
  if (report.result && report.result.snapshot) {
    console.log(`Snapshot: used ${report.result.snapshot.usedPercent}% / commit ${report.result.snapshot.commitPercent}% / processes ${report.result.snapshot.processCount}`);
  }
  if (report.result && report.result.selfUsage) {
    console.log(`Self usage: ${report.result.selfUsage.totalWorkingSetMB} MB / ${report.result.selfUsage.processCount} processes`);
  }
  if (report.screenshot) {
    console.log(`Screenshot: ${path.resolve(report.screenshot)}`);
  }
  for (const failure of report.failures || []) {
    console.log(`- ${failure}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runSmoke(options);
  printResult(report, options.json);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
