const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function run(label, command, args) {
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function runCapture(label, command, args) {
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    throw new Error(`${label} failed with exit code ${result.status || 1}`);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result.stdout || '';
}

function assertVerify(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function verifyTrimPlan() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memguard-verify-data-'));
  try {
    const output = runCapture('PowerShell trim-plan dry-run', powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(root, 'engine', 'memguard-engine.ps1'),
      '-Mode',
      'trim-plan',
      '-Reason',
      'verify-dry-run',
      '-DataDir',
      dataDir
    ]).trim();

    assertVerify(output, 'trim-plan produced no output');

    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch (error) {
      throw new Error(`trim-plan output is not valid JSON: ${error.message}`);
    }

    assertVerify(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'trim-plan JSON output must be an object');
    assertVerify(parsed.trimPlan && typeof parsed.trimPlan === 'object' && !Array.isArray(parsed.trimPlan), 'trim-plan JSON must include a trimPlan object');
    assertVerify(typeof parsed.trimPlan.selectedCandidateCount === 'number', 'trimPlan.selectedCandidateCount must be a number');
    assertVerify(typeof parsed.trimPlan.skippedSensitiveProcessCount === 'number', 'trimPlan.skippedSensitiveProcessCount must be a number');
    assertVerify(Array.isArray(parsed.trimPlan.skippedSensitiveProcesses), 'trimPlan.skippedSensitiveProcesses must be an array');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function verifyCodexSelfTest() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memguard-self-test-data-'));
  try {
    const output = runCapture('PowerShell codex self-test', powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(root, 'engine', 'memguard-engine.ps1'),
      '-Mode',
      'codex-self-test',
      '-DataDir',
      dataDir
    ]).trim();
    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch (error) {
      throw new Error(`codex self-test output is not valid JSON: ${error.message}`);
    }
    assertVerify(parsed && parsed.passed === true, 'codex self-test must report passed=true');
    const assertions = Array.isArray(parsed.assertions) ? parsed.assertions : [];
    assertVerify(assertions.length > 0, 'codex self-test must include assertion results');
    const failed = assertions.filter((item) => !item || item.passed !== true);
    assertVerify(failed.length === 0, `codex self-test failures: ${failed.map((item) => item && item.name || 'unknown').join(', ')}`);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function verifyPackageConfig() {
  console.log('\n> package config');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assertVerify(pkg.scripts && pkg.scripts['bench:runtime'] === 'node tools/runtime-benchmark.js', 'package.json must expose bench:runtime');
  assertVerify(pkg.scripts && pkg.scripts['smoke:dashboard'] === 'node tools/dashboard-smoke.js', 'package.json must expose smoke:dashboard');
  assertVerify(pkg.scripts && pkg.scripts['smoke:widget'] === 'node tools/widget-smoke.js', 'package.json must expose smoke:widget');
  assertVerify(pkg.build && pkg.build.afterPack === 'build/afterPack.js', 'package.json must wire build/afterPack.js');
  const buildFiles = pkg && pkg.build && Array.isArray(pkg.build.files) ? pkg.build.files : [];
  const requiredRuntimeFiles = [
    'src/main.js',
    'src/preload.js',
    'src/renderer.html',
    'src/renderer.js',
    'src/styles.css',
    'src/dashboard.html',
    'src/dashboard.js',
    'src/dashboard.css',
    'src/system-snapshot.js',
    'engine/**/*',
    'assets/**/*'
  ];
  for (const file of requiredRuntimeFiles) {
    assertVerify(buildFiles.includes(file), `package.json build.files must include runtime file ${file}`);
  }
  assertVerify(!buildFiles.includes('src/**/*'), 'package.json build.files should whitelist runtime files instead of packaging all src files');
  assertVerify(!buildFiles.some((item) => String(item).includes('process-tree')), 'package.json build.files must not package process-tree benchmark helper');
  const extraFiles = pkg && pkg.build && Array.isArray(pkg.build.extraFiles) ? pkg.build.extraFiles : [];
  const expectedReadme = String.fromCharCode(0x4f7f, 0x7528, 0x8bf4, 0x660e) + '.txt';
  assertVerify(extraFiles.includes(expectedReadme), 'package.json build.extraFiles must include 使用说明.txt');
  assertVerify(fs.existsSync(path.join(root, expectedReadme)), 'source 使用说明.txt must exist for electron-builder extraFiles');
  assertVerify(!extraFiles.some((item) => String(item).includes('?')), 'package.json build.extraFiles must not include corrupted question-mark filenames');
  const afterPack = fs.readFileSync(path.join(root, 'build', 'afterPack.js'), 'utf8');
  for (const file of ['dxcompiler.dll', 'dxil.dll', 'vk_swiftshader.dll', 'vulkan-1.dll']) {
    assertVerify(afterPack.includes(file), `afterPack.js must remove ${file}`);
  }
  assertVerify(afterPack.includes('MEMGUARD_KEEP_GPU_FALLBACKS'), 'afterPack.js must provide a GPU fallback escape hatch');
}

function verifyRuntimeBenchmarkHelp() {
  const help = runCapture('runtime benchmark help', process.execPath, ['tools/runtime-benchmark.js', '--help']);
  assertVerify(help.includes('--mode <packed|dev>'), 'runtime benchmark help must document --mode packed|dev');
  assertVerify(help.includes('default packed'), 'runtime benchmark help must document packed as the default mode');
  assertVerify(help.includes('dist/win-unpacked/MemGuard.exe'), 'runtime benchmark help must mention the packed MemGuard.exe target');
  const benchmark = fs.readFileSync(path.join(root, 'tools', 'runtime-benchmark.js'), 'utf8');
  assertVerify(benchmark.includes("require('./memguard-test-harness')"), 'runtime benchmark must reuse the shared smoke harness');
  assertVerify(benchmark.includes('createIsolatedDataDir') && benchmark.includes('writeIsolatedConfig'), 'runtime benchmark must reuse harness data-dir helpers');
  assertVerify(benchmark.includes('startMemGuard') && benchmark.includes('extraArgsBeforeMarker: true'), 'runtime benchmark must launch through harness while preserving extra-switch order');
  assertVerify(!benchmark.includes('function startApp') && !benchmark.includes('function writeConfig'), 'runtime benchmark must not keep duplicate launch/config helpers');
  const harness = fs.readFileSync(path.join(root, 'tools', 'memguard-test-harness.js'), 'utf8');
  assertVerify(harness.includes('extraArgsBeforeMarker = false'), 'harness extraArgsBeforeMarker must default to false for smoke compatibility');
}

function verifySmokeHelp() {
  for (const [label, file] of [['dashboard smoke help', 'tools/dashboard-smoke.js'], ['widget smoke help', 'tools/widget-smoke.js']]) {
    const help = runCapture(label, process.execPath, [file, '--help']);
    assertVerify(help.includes('--mode <packed|dev>'), `${file} help must document --mode packed|dev`);
    assertVerify(help.includes('default packed'), `${file} help must document packed as the default mode`);
    assertVerify(help.includes('dist/win-unpacked/MemGuard.exe'), `${file} help must mention the packed MemGuard.exe target`);
    assertVerify(help.includes('--screenshot <path>'), `${file} help must document screenshot output`);
  }
}

function verifyDashboardConfigBindings() {
  console.log('\n> dashboard config bindings');
  const html = fs.readFileSync(path.join(root, 'src', 'dashboard.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'src', 'dashboard.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src', 'dashboard.css'), 'utf8');
  const visibleConfigFields = [
    'triggerPercent',
    'minProcessMB',
    'cooldownMinutes',
    'checkSeconds',
    'adaptiveCheckIntervalEnabled',
    'consecutiveHighChecks',
    'memoryMode',
    'lowResourceMode',
    'showWidgetOnStart',
    'disableHardwareAcceleration',
    'trimOnStart',
    'historyLimit',
    'codexGuardEnabled',
    'codexAutoCleanAfterCodexExit',
    'codexAutoCleanWhileRunning',
    'codexCleanWhileRunning',
    'codexStaleMinutes',
    'codexMaxMcpProcesses',
    'codexCommitPressurePercent',
    'codexScanIntervalSeconds',
    'codexAutoCleanWhileRunningCooldownMinutes',
    'codexAutoCleanWhileRunningMaxKillsPerPass',
    'codexDryRunByDefault'
  ];
  for (const field of visibleConfigFields) {
    assertVerify(html.includes(`name="${field}"`), `dashboard.html must expose ${field}`);
    assertVerify(js.includes(field), `dashboard.js must bind ${field}`);
  }
  assertVerify(html.includes('applyLowResourceButton') && js.includes('applyLowResourceProfile'), 'low resource profile button must be wired');
  assertVerify(html.includes('trimPlanStatus') && js.includes('setTrimPlanStatus'), 'ordinary trim preview must use a dedicated status area');
  assertVerify(!js.includes("codexStatus.textContent = '正在生成普通内存清理计划"), 'ordinary trim preview must not overwrite Codex status');
  assertVerify(js.includes('buildRescueConfirmMessage') && js.includes('rescuePressureSummary'), 'rescue confirmation must include current pressure context');
  assertVerify(js.includes('getRescueContext') && js.includes('codexScanCache'), 'rescue confirmation must reuse cached Codex scan context when available');
  assertVerify(html.includes('pressureActionBar') && html.includes('pressureActionTitle'), 'dashboard must expose a pressure action recommendation bar');
  for (const id of ['pressureActionLabel', 'pressureActionDetail', 'pressureActionHint']) {
    assertVerify(html.includes(id), `dashboard.html must expose ${id}`);
  }
  assertVerify(js.includes('buildPressureAction') && js.includes('renderPressureAction') && js.includes('setRecommendedButtons'), 'dashboard must render pressure action recommendations');
  for (const action of ['codexScan', 'codexDryRun', 'trimPlan', 'rescue']) {
    assertVerify(js.includes(action), `pressure recommendations must support ${action}`);
  }
  assertVerify(js.includes('button-recommended') && js.includes('codexScanButton'), 'pressure recommendations must highlight the next suggested action');
  for (const level of ['normal', 'watch', 'pressure', 'critical']) {
    assertVerify(css.includes(`pressure-action-${level}`), `dashboard CSS must style pressure-action-${level}`);
  }
  assertVerify(css.includes('pressure-action-bar') && css.includes('button-recommended'), 'dashboard CSS must style pressure recommendations');
}

function verifyLowResourceHotPaths() {
  console.log('\n> low-resource hot paths');
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  const configExample = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
  assertVerify(configExample.lowResourceMode === true, 'default config must keep lowResourceMode enabled');
  assertVerify(configExample.showWidgetOnStart === false, 'default config must keep the widget hidden on startup');
  assertVerify(configExample.trimOnStart === false, 'default config must not perform a real trim immediately on startup');
  assertVerify(main.includes('trimOnStart: false'), 'main defaultConfig must not perform a real trim immediately on startup');
  assertVerify(/app\.on\('second-instance',\s*\(\)\s*=>\s*{\s*updateTrayMenu\(\);\s*}\);/.test(main), 'second app launch must stay unobtrusive and avoid opening Dashboard');
  assertVerify(main.includes("tray.on('click', () => tray.popUpContextMenu())"), 'tray single-click must open the menu instead of forcing Dashboard focus');
  assertVerify(main.includes("tray.on('double-click', createDashboard)"), 'tray double-click must remain available for opening Dashboard');
  assertVerify(!renderer.includes('setInterval(paint'), 'widget renderer must not keep a permanent paint interval');
  assertVerify(renderer.includes('scheduleNextPaint') && renderer.includes('nextPaintDelay'), 'widget renderer must schedule repaint only for visible state deadlines');
  assertVerify(renderer.includes('paint();\n  startAnimation();'), 'widget renderer must paint the first snapshot before waiting for animation frames');
  const snapshot = fs.readFileSync(path.join(root, 'src', 'system-snapshot.js'), 'utf8');
  assertVerify(snapshot.includes('cachedLastTrim') && snapshot.includes('prior.lastTrim'), 'fast snapshot must reuse cached lastTrim before reading disk');
  assertVerify(main.includes('fullSnapshotInFlight') && main.includes('function fullSnapshot'), 'full PowerShell snapshots must reuse in-flight work');
  assertVerify(main.includes('if (fullSnapshotInFlight)') && main.includes('return fullSnapshotInFlight'), 'concurrent full snapshot requests must share the in-flight promise');
  assertVerify(main.includes('snapshotGeneration') && main.includes('generation !== snapshotGeneration'), 'full snapshot cache writes must be guarded against stale in-flight results');
  assertVerify(main.includes('fullSnapshotInFlight === run') && main.includes('fullSnapshotInFlight = null'), 'full snapshot in-flight state must clear only the active promise');
  assertVerify(main.includes('const result = await fullSnapshot'), 'getSnapshot must route full snapshot work through the in-flight helper');
  assertVerify(main.includes('codexScanInFlight') && main.includes('invalidateCodexScanCache'), 'Codex scan must reuse in-flight work and clear stale scan state after cleaning');
  assertVerify(main.includes('if (!force && codexScanInFlight)') && main.includes('codexScanInFlight = run'), 'non-forced Codex scans must reuse the in-flight scan promise');
  assertVerify(main.includes('codexScanGeneration') && main.includes('generation === codexScanGeneration'), 'Codex scan cache writes must be guarded against stale in-flight results');
}

for (const file of [
  'src/main.js',
  'src/preload.js',
  'src/renderer.js',
  'src/dashboard.js',
  'src/process-tree.js',
  'src/system-snapshot.js',
  'src/snapshot-benchmark.js',
  'build/afterPack.js',
  'tools/verify.js',
  'tools/runtime-benchmark.js',
  'tools/memguard-test-harness.js',
  'tools/dashboard-smoke.js',
  'tools/widget-smoke.js'
]) {
  run(`node --check ${file}`, process.execPath, ['--check', file]);
}

run('snapshot benchmark', process.execPath, ['src/snapshot-benchmark.js', '1000']);
verifyCodexSelfTest();
verifyPackageConfig();
verifyRuntimeBenchmarkHelp();
verifySmokeHelp();
verifyDashboardConfigBindings();
verifyLowResourceHotPaths();
try {
  verifyTrimPlan();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

console.log('\nverify passed');
