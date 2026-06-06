const fs = require('fs');
const { classifyProcess, getProcessTree, summarizeProcessTree } = require('../src/process-tree');
const {
  getLaunchTarget,
  createIsolatedDataDir,
  writeIsolatedConfig,
  sleep,
  getProcessRow,
  ownsProcess,
  stopTree,
  findResidualProcesses,
  canRemoveIsolatedDataDir,
  startMemGuard
} = require('./memguard-test-harness');

const markerFileName = '.memguard-runtime-benchmark';
const markerArgName = 'memguard-runtime-data-dir';
const dataDirPrefix = 'memguard-runtime-';

const scenarios = {
  'tray': {
    lowResourceMode: true,
    showWidgetOnStart: false,
    disableHardwareAcceleration: false,
    openDashboard: false
  },
  'tray-gpu-off': {
    lowResourceMode: true,
    showWidgetOnStart: false,
    disableHardwareAcceleration: true,
    openDashboard: false
  },
  'widget': {
    lowResourceMode: true,
    showWidgetOnStart: true,
    disableHardwareAcceleration: false,
    openDashboard: false
  },
  'widget-gpu-off': {
    lowResourceMode: true,
    showWidgetOnStart: true,
    disableHardwareAcceleration: true,
    openDashboard: false
  },
  'dashboard': {
    lowResourceMode: true,
    showWidgetOnStart: false,
    disableHardwareAcceleration: false,
    openDashboard: true
  },
  'dashboard-gpu-off': {
    lowResourceMode: true,
    showWidgetOnStart: false,
    disableHardwareAcceleration: true,
    openDashboard: true
  }
};

function parseArgs(argv) {
  const options = {
    mode: 'packed',
    scenario: 'tray',
    compare: false,
    sampleMs: 8000,
    settleMs: 3500,
    json: false,
    keepDataDir: false,
    extraSwitches: []
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--mode') {
      options.mode = argv[++index] || options.mode;
    } else if (arg === '--scenario') {
      options.scenario = argv[++index] || options.scenario;
    } else if (arg === '--compare') {
      options.compare = true;
    } else if (arg === '--sample-ms') {
      options.sampleMs = Number(argv[++index] || options.sampleMs);
    } else if (arg === '--settle-ms') {
      options.settleMs = Number(argv[++index] || options.settleMs);
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--keep-data-dir') {
      options.keepDataDir = true;
    } else if (arg === '--extra-switch') {
      options.extraSwitches.push(parseSwitch(argv[++index] || ''));
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
  if (!scenarios[options.scenario]) {
    throw new Error(`Unknown scenario "${options.scenario}". Use one of: ${Object.keys(scenarios).join(', ')}`);
  }
  if (!Number.isFinite(options.sampleMs) || options.sampleMs < 1000) {
    throw new Error('--sample-ms must be at least 1000');
  }
  if (!Number.isFinite(options.settleMs) || options.settleMs < 1000) {
    throw new Error('--settle-ms must be at least 1000');
  }
  return options;
}

function parseSwitch(value) {
  const trimmed = String(value || '').trim().replace(/^--/, '');
  if (!trimmed) throw new Error('--extra-switch requires a switch name');
  const [name, ...rest] = trimmed.split('=');
  return {
    name,
    value: rest.length ? rest.join('=') : ''
  };
}

function printHelp() {
  console.log(`Usage: node tools/runtime-benchmark.js [options]

Options:
  --mode <packed|dev>  Launch dist/win-unpacked/MemGuard.exe or local Electron, default packed
  --scenario <name>   ${Object.keys(scenarios).join(' | ')}
  --compare           Run all runtime scenarios
  --settle-ms <ms>    Time to wait before sampling, default 3500
  --sample-ms <ms>    Sampling window, default 8000
  --json             Print JSON only
  --keep-data-dir    Keep isolated benchmark data directory
  --extra-switch     Append Chromium switch for experiments, repeatable
`);
}

function summarize(samples) {
  const latest = samples[samples.length - 1] || [];
  const latestSummary = summarizeProcessTree(latest);
  const peakSummary = peakSummaries(samples);
  const helperSummary = summarizeProcessTree(latest.filter((row) => !isElectronRuntime(row)));
  return {
    ...latestSummary,
    latest: latestSummary,
    peak: peakSummary,
    helpers: helperSummary,
    processes: latest.map((row) => ({
      pid: row.pid,
      parentPid: row.parentPid,
      type: classifyProcess(row),
      name: row.name,
      workingSetMB: row.workingSetMB,
      privateMB: row.privateMB
    }))
  };
}

function peakSummaries(samples) {
  const summaries = samples.map((sample) => summarizeProcessTree(sample));
  return {
    processCount: Math.max(...summaries.map((item) => item.processCount), 0),
    totalWorkingSetMB: round(Math.max(...summaries.map((item) => item.totalWorkingSetMB), 0)),
    totalPrivateMB: round(Math.max(...summaries.map((item) => item.totalPrivateMB), 0))
  };
}

function isElectronRuntime(row) {
  const type = classifyProcess(row);
  return ['browser-main', 'gpu', 'utility', 'renderer', 'crashpad'].includes(type);
}

function compareResults(results) {
  const base = results.find((result) => result.scenario === 'tray') || results[0];
  return results.map((result) => ({
    mode: result.mode,
    scenario: result.scenario,
    processCount: result.summary.processCount,
    totalWorkingSetMB: result.summary.totalWorkingSetMB,
    totalPrivateMB: result.summary.totalPrivateMB,
    deltaWorkingSetMB: round(result.summary.totalWorkingSetMB - base.summary.totalWorkingSetMB),
    deltaPrivateMB: round(result.summary.totalPrivateMB - base.summary.totalPrivateMB),
    byType: result.summary.byType
  }));
}

function printResult(result) {
  console.log(`\nMemGuard runtime benchmark: ${result.scenario}`);
  console.log(`Mode: ${result.mode}`);
  if (result.extraSwitches.length) {
    console.log(`Extra switches: ${result.extraSwitches.map(formatSwitch).join(', ')}`);
  }
  console.log(`Processes: ${result.summary.processCount}`);
  console.log(`Working set: ${result.summary.totalWorkingSetMB} MB`);
  console.log(`Private: ${result.summary.totalPrivateMB} MB`);
  if (result.summary.peak) {
    console.log(`Peak during sample: ${result.summary.peak.totalWorkingSetMB} MB ws / ${result.summary.peak.totalPrivateMB} MB private / ${result.summary.peak.processCount} proc`);
  }
  if (result.summary.helpers && result.summary.helpers.processCount) {
    console.log(`Non-Electron helpers in latest sample: ${result.summary.helpers.processCount} proc, ws ${result.summary.helpers.totalWorkingSetMB} MB, private ${result.summary.helpers.totalPrivateMB} MB`);
  }
  for (const [type, value] of Object.entries(result.summary.byType)) {
    console.log(`- ${type}: ${value.count} proc, ws ${value.workingSetMB} MB, private ${value.privateMB} MB`);
  }
}

function formatSwitch(item) {
  return item.value ? `--${item.name}=${item.value}` : `--${item.name}`;
}

function printComparison(results) {
  const rows = compareResults(results);
  console.log('\nMemGuard runtime comparison');
  if (results[0] && results[0].mode) {
    console.log(`Mode: ${results[0].mode}`);
  }
  console.log('Scenario          Proc  WorkingSet  Private  WS delta  Private delta');
  for (const row of rows) {
    console.log([
      row.scenario.padEnd(16),
      String(row.processCount).padStart(4),
      `${row.totalWorkingSetMB.toFixed(1)} MB`.padStart(10),
      `${row.totalPrivateMB.toFixed(1)} MB`.padStart(9),
      `${formatSigned(row.deltaWorkingSetMB)} MB`.padStart(9),
      `${formatSigned(row.deltaPrivateMB)} MB`.padStart(13)
    ].join('  '));
  }
}

function formatSigned(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}

function round(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

async function runBenchmark(options) {
  const target = getLaunchTarget(options.mode, 'npm run bench:runtime');
  const userDataDir = createIsolatedDataDir(`${dataDirPrefix}${options.scenario}-`, markerFileName);
  const scenarioConfig = scenarios[options.scenario];
  writeIsolatedConfig(userDataDir, scenarioConfig);
  const child = startMemGuard({
    target,
    userDataDir,
    markerArgName,
    openDashboard: scenarioConfig.openDashboard,
    extraArgs: (options.extraSwitches || []).map(formatSwitch),
    extraArgsBeforeMarker: true
  });
  let exited = false;
  let exitCode = null;
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
  });
  const samples = [];
  try {
    await sleep(options.settleMs);
    if (exited) {
      throw new Error(`MemGuard exited before sampling with code ${exitCode}.`);
    }
    const row = getProcessRow(child.pid);
    if (row && !ownsProcess(row, target, markerArgName, userDataDir)) {
      throw new Error(`Benchmark process ownership check failed for PID ${child.pid}.`);
    }
    const deadline = Date.now() + options.sampleMs;
    while (Date.now() <= deadline) {
      const sample = getProcessTree(child.pid);
      if (!sample.length) {
        throw new Error(`MemGuard process tree is empty for root pid ${child.pid}`);
      }
      samples.push(sample);
      await sleep(1000);
    }
    return {
      mode: options.mode,
      scenario: options.scenario,
      sampleMs: options.sampleMs,
      settleMs: options.settleMs,
      extraSwitches: options.extraSwitches,
      rootPid: child.pid,
      targetCommand: target.command,
      userDataDir: options.keepDataDir ? userDataDir : null,
      summary: summarize(samples),
      sampleCount: samples.length
    };
  } finally {
    stopTree(child.pid, target, markerArgName, userDataDir);
    await sleep(500);
    const residualProcesses = findResidualProcesses(userDataDir);
    if (!options.keepDataDir) {
      if (!canRemoveIsolatedDataDir(userDataDir, `${dataDirPrefix}${options.scenario}-`, markerFileName)) {
        throw new Error(`Refusing to delete non-benchmark data directory: ${userDataDir}`);
      }
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
    if (residualProcesses.length) {
      throw new Error(`Runtime benchmark process residuals remain for ${userDataDir}: ${residualProcesses.map((row) => `${row.Name}#${row.ProcessId}`).join(', ')}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.compare) {
    const names = Object.keys(scenarios);
    const results = [];
    for (const scenario of names) {
      results.push(await runBenchmark({ ...options, scenario }));
    }
    if (options.json) {
      console.log(JSON.stringify({ mode: options.mode, results, comparison: compareResults(results) }, null, 2));
    } else {
      printComparison(results);
    }
    return;
  }

  const result = await runBenchmark(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
