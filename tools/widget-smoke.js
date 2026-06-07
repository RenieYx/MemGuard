const path = require('path');
const {
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

const markerFileName = '.memguard-widget-smoke';
const markerArgName = 'memguard-widget-smoke-data-dir';
const dataDirPrefix = 'memguard-widget-smoke-';

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
  console.log(`Usage: node tools/widget-smoke.js [options]

Options:
  --mode <packed|dev>       Launch dist/win-unpacked/MemGuard.exe or local Electron, default packed
  --timeout-ms <ms>         Max wait for widget and IPC checks, default 30000
  --port <port>             Remote debugging port; default picks a free local port
  --json                    Print JSON only
  --keep-data-dir           Keep the isolated temporary userData directory
  --screenshot <path>       Save a widget screenshot to this path
`);
}

function widgetExpression() {
  return `window.memguard.getWidgetState().then((state) => {
    const ids = ['card', 'percent', 'free', 'last', 'fill', 'cleanButton'];
    const missing = ids.filter((item) => !document.getElementById(item));
    const card = document.getElementById('card');
    const cleanButton = document.getElementById('cleanButton');
    const api = window.memguard || {};
    return {
      title: document.title,
      missing,
      bodyLength: document.body.innerText.length,
      hasWidgetApi: [
        'trimNow',
        'onError',
        'onSnapshot',
        'onTrimResult',
        'onCleaningState',
        'onPauseState',
        'getWidgetState',
        'showMenu'
      ].every((name) => typeof api[name] === 'function'),
      percentText: document.getElementById('percent')?.textContent?.trim() || '',
      freeText: document.getElementById('free')?.textContent?.trim() || '',
      lastText: document.getElementById('last')?.textContent?.trim() || '',
      fillWidth: document.getElementById('fill')?.style?.width || '',
      cardClass: card ? card.className : '',
      cleanButtonDisabled: cleanButton ? cleanButton.disabled : null,
      cleanButtonType: cleanButton ? cleanButton.type : '',
      snapshot: {
        usedPercent: state && state.usedPercent,
        freeGB: state && state.freeGB,
        pressureLevel: state && state.pressureLevel,
        pausedUntil: state && state.pausedUntil,
        source: state && state.source
      }
    };
  })`;
}

function assertSmoke(condition, message, failures) {
  if (!condition) failures.push(message);
}

function validateResult(result) {
  const failures = [];
  assertSmoke(result && typeof result === 'object', 'widget inspection returned no result', failures);
  if (!result) return failures;

  assertSmoke(String(result.title || '').includes('MemGuard'), 'widget title should include MemGuard', failures);
  assertSmoke(Array.isArray(result.missing) && result.missing.length === 0, `missing widget elements: ${(result.missing || []).join(', ')}`, failures);
  assertSmoke(Number(result.bodyLength || 0) > 5, 'widget body text is unexpectedly short', failures);
  assertSmoke(result.hasWidgetApi === true, 'widget preload API must expose widget methods', failures);
  assertSmoke(String(result.percentText || '').includes('%') && !String(result.percentText || '').includes('--'), 'widget percent text should render a numeric percent', failures);
  assertSmoke(String(result.freeText || '').toLowerCase().includes('gb'), 'widget free memory text should render GB units', failures);
  assertSmoke(String(result.fillWidth || '').includes('%'), 'widget fill width should be a percentage', failures);
  assertSmoke(result.cleanButtonDisabled === false, 'clean button should be enabled after idle widget load', failures);
  assertSmoke(result.cleanButtonType === 'button', 'clean button must be non-submit button', failures);
  assertSmoke(Number.isFinite(Number(result.snapshot && result.snapshot.usedPercent)), 'widget state usedPercent must be numeric', failures);
  assertSmoke(Number.isFinite(Number(result.snapshot && result.snapshot.freeGB)), 'widget state freeGB must be numeric', failures);
  assertSmoke(['normal', 'watch', 'pressure', 'critical'].includes(String(result.snapshot && result.snapshot.pressureLevel || '')), 'widget pressureLevel must be known', failures);
  return failures;
}

async function runSmoke(options) {
  requireRuntimeSupport();
  const target = getLaunchTarget(options.mode, 'npm run smoke:widget');
  const port = options.port || await findFreePort();
  const userDataDir = createIsolatedDataDir(dataDirPrefix, markerFileName);
  writeIsolatedConfig(userDataDir, { showWidgetOnStart: true });
  const child = startMemGuard({
    target,
    userDataDir,
    markerArgName,
    port,
    openDashboard: false
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
      throw new Error(`Widget smoke process ownership check failed for PID ${child.pid}.`);
    }
    const page = await waitForPage(port, '/renderer.html', options.timeoutMs);
    if (exited) {
      throw new Error(`MemGuard exited before widget inspection with code ${exitCode}`);
    }
    const result = await inspectPage(page, options, widgetExpression(), 1000);
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
  console.log('\nMemGuard widget smoke');
  console.log(`Mode: ${report.mode}`);
  console.log(`Result: ${report.ok ? 'PASS' : 'FAIL'}`);
  if (report.result && report.result.snapshot) {
    console.log(`Snapshot: used ${report.result.snapshot.usedPercent}% / free ${report.result.snapshot.freeGB} GB / pressure ${report.result.snapshot.pressureLevel}`);
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
