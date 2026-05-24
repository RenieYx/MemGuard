const usedPercent = document.getElementById('usedPercent');
const freeGB = document.getElementById('freeGB');
const lastTrim = document.getElementById('lastTrim');
const meterFill = document.getElementById('meterFill');
const subtitle = document.getElementById('subtitle');
const settingsForm = document.getElementById('settingsForm');
const saveState = document.getElementById('saveState');
const historyList = document.getElementById('historyList');
const refreshButton = document.getElementById('refreshButton');
const cleanButton = document.getElementById('cleanButton');
const minimizeWindow = document.getElementById('minimizeWindow');
const closeWindow = document.getElementById('closeWindow');

const codexScanButton = document.getElementById('codexScanButton');
const codexDryRunButton = document.getElementById('codexDryRunButton');
const codexCleanButton = document.getElementById('codexCleanButton');
const codexRunning = document.getElementById('codexRunning');
const codexCandidates = document.getElementById('codexCandidates');
const codexCandidateMemory = document.getElementById('codexCandidateMemory');
const codexCleanable = document.getElementById('codexCleanable');
const codexCommit = document.getElementById('codexCommit');
const codexStatus = document.getElementById('codexStatus');
const codexGroupMeta = document.getElementById('codexGroupMeta');
const codexGroupList = document.getElementById('codexGroupList');
const codexCleanableCount = document.getElementById('codexCleanableCount');
const codexProtectedCount = document.getElementById('codexProtectedCount');
const codexSuspiciousCount = document.getElementById('codexSuspiciousCount');
const codexCleanableList = document.getElementById('codexCleanableList');
const codexProtectedList = document.getElementById('codexProtectedList');
const codexSuspiciousList = document.getElementById('codexSuspiciousList');

let currentConfig = {};

function lastText(iso) {
  if (!iso) return '--';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '--';
  const diff = Date.now() - then;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  return new Date(then).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fillForm(config) {
  for (const [key, value] of Object.entries(config)) {
    const field = settingsForm.elements[key];
    if (!field) continue;
    if (field.type === 'checkbox') {
      field.checked = Boolean(value);
    } else {
      field.value = value;
    }
  }
}

function formConfig() {
  const data = new FormData(settingsForm);
  return {
    ...currentConfig,
    triggerPercent: Number(data.get('triggerPercent')),
    minProcessMB: Number(data.get('minProcessMB')),
    cooldownMinutes: Number(data.get('cooldownMinutes')),
    checkSeconds: Number(data.get('checkSeconds')),
    consecutiveHighChecks: Number(data.get('consecutiveHighChecks')),
    historyLimit: Number(data.get('historyLimit')),
    trimOnStart: settingsForm.elements.trimOnStart.checked,
    codexAutoCleanWhileRunning: settingsForm.elements.codexAutoCleanWhileRunning.checked,
    codexAutoCleanWhileRunningCooldownMinutes: Number(data.get('codexAutoCleanWhileRunningCooldownMinutes')),
    codexAutoCleanWhileRunningMaxKillsPerPass: Number(data.get('codexAutoCleanWhileRunningMaxKillsPerPass'))
  };
}

function reasonText(reason) {
  const map = {
    startup: '启动清理',
    manual: '手动清理',
    menu: '菜单清理',
    auto: '自动清理',
    verify: '验证',
    'codex-dry-run': 'Codex 预演',
    'codex-manual': 'Codex 清理',
    'codex-auto-after-exit': 'Codex 退出后自动清理',
    'codex-auto-while-running': 'Codex 运行中自动清理',
    'emergency-previous-session-orphans': '紧急清理旧会话残留',
    'live-stdio-app-server': '当前 stdio app-server，已保护',
    'live-desktop-root': '当前 Codex 桌面树，已保护',
    'live-codex-other': '当前 Codex 进程树，已保护',
    'desktop-app-server-younger-than-10m': '最近启动的桌面 app-server 工具，已保护',
    'live-desktop-app-server-latest-or-singleton': '最新或单例工具，已保护',
    'duplicate-desktop-app-server-tool': '桌面 app-server 下的旧重复工具链',
    'duplicate-desktop-app-server-tool-report-only': '旧重复工具链，报告模式不清理',
    'duplicate-desktop-app-server-tool-pressure-not-met': '旧重复工具链，等待压力阈值',
    'codex-not-running-and-allowlisted-orphan': 'Codex 已退出的残留工具链',
    'previous-codex-session-orphan-while-running': '旧会话断链残留',
    'previous-codex-session-missing-parent-chain-while-running': '旧会话父链缺失残留',
    'allow-stale-orphan-while-codex-running': '允许清理的过期断链工具',
    'allowlisted-stale-but-parent-chain-not-cleanable': '过期但父链不满足自动清理',
    'non-codex-dev-server-pattern': '开发服务器，仅报告'
  };
  return map[reason] || reason || '未知';
}

function renderHistory(history) {
  historyList.innerHTML = '';
  if (!history.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有清理记录。';
    historyList.append(empty);
    return;
  }

  for (const item of history.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'history-item';

    const time = document.createElement('time');
    time.textContent = new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    const detail = document.createElement('span');
    if (item.type === 'codex') {
      detail.textContent = `${reasonText(item.reason)} / 目标 ${item.targetCount ?? 0} / 已结束 ${item.killedCount ?? 0}`;
    } else {
      detail.textContent = `${reasonText(item.reason)} / ${item.trimmedProcesses ?? 0} 个进程 / ${item.beforePercent ?? '--'}% -> ${item.afterPercent ?? '--'}%`;
    }

    const result = document.createElement('strong');
    result.textContent = item.type === 'codex'
      ? `${item.beforeCleanable ?? 0}->${item.afterCleanable ?? '--'}`
      : `+${Number(item.freedGB || 0).toFixed(2)} GB`;

    row.append(time, detail, result);
    historyList.append(row);
  }
}

function renderState(state) {
  const snapshot = state.snapshot || {};
  const percent = Number(snapshot.usedPercent || 0);
  currentConfig = state.config || {};
  usedPercent.textContent = `${percent.toFixed(1)}%`;
  freeGB.textContent = `${Number(snapshot.freeGB || 0).toFixed(1)} GB`;
  lastTrim.textContent = lastText(snapshot.lastTrim);
  meterFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  subtitle.textContent = state.pausedUntil && Date.now() < state.pausedUntil ? '自动清理已暂停' : '内存守护控制台';
  fillForm(state.config || {});
  renderHistory(state.history || []);
}

async function refresh() {
  renderState(await window.memguard.getDashboardState());
}

function processTitle(item) {
  return `${item.name || '进程'} #${item.pid} / ${Number(item.workingSetMB || 0).toFixed(1)} MB`;
}

function formatMB(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '--';
  if (number >= 1024) return `${(number / 1024).toFixed(1)} GB`;
  return `${number.toFixed(0)} MB`;
}

function renderProcessList(container, items, emptyText) {
  container.innerHTML = '';
  if (!items || !items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }

  for (const item of items.slice(0, 24)) {
    const row = document.createElement('div');
    row.className = 'process-item';

    const title = document.createElement('strong');
    title.textContent = processTitle(item);

    const meta = document.createElement('span');
    const group = item.duplicateCount ? ` / 分组 ${item.duplicateRank}/${item.duplicateCount}` : '';
    meta.textContent = `${reasonText(item.reason)} / 已运行 ${item.ageMinutes ?? '--'} 分钟${group}`;

    const cmd = document.createElement('code');
    cmd.textContent = item.commandLine || '';

    row.append(title, meta, cmd);
    container.append(row);
  }
}

function renderGroupList(groups) {
  codexGroupList.innerHTML = '';
  const list = Array.isArray(groups) ? groups : [];
  const shown = Math.min(list.length, 8);
  codexGroupMeta.textContent = list.length ? `显示 ${shown} / ${list.length} 组` : '暂无分组';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有候选工具分组。';
    codexGroupList.append(empty);
    return;
  }

  for (const group of list.slice(0, 8)) {
    const row = document.createElement('div');
    row.className = 'group-item';

    const title = document.createElement('strong');
    title.textContent = group.label || group.toolKey || group.key || '工具分组';

    const meta = document.createElement('span');
    meta.textContent = `${group.count || 0} 个进程 / 可清理 ${group.cleanableCount || 0} / 保护 ${group.protectedCount || 0} / 待确认 ${group.suspiciousCount || 0}`;

    const memory = document.createElement('code');
    memory.textContent = `私有 ${formatMB(group.privateMB)} / 工作集 ${formatMB(group.workingSetMB)}`;

    row.append(title, meta, memory);
    codexGroupList.append(row);
  }
}

function renderCodexScan(scan, statusText) {
  const summary = scan && scan.summary ? scan.summary : {};
  const codex = scan && scan.codex ? scan.codex : {};
  const snapshot = scan && scan.snapshot ? scan.snapshot : {};
  const hasPressure = Boolean(summary.overProcessLimit || summary.overCommitPressure);
  const hasCleanable = Number(summary.cleanableCount || 0) > 0;

  codexRunning.textContent = codex.running ? `${codex.count || 0} 个进程` : '未运行';
  codexCandidates.textContent = String(summary.candidateCount ?? '--');
  codexCandidateMemory.textContent = `私有 ${formatMB(summary.candidatePrivateMB)} / 工作集 ${formatMB(summary.candidateWorkingSetMB)}`;
  codexCleanable.textContent = String(summary.cleanableCount ?? '--');
  codexCommit.textContent = snapshot.commitPercent == null ? '--' : `${Number(snapshot.commitPercent).toFixed(1)}%`;
  codexCleanableCount.textContent = String(summary.cleanableCount ?? 0);
  codexProtectedCount.textContent = String(summary.protectedCount ?? 0);
  codexSuspiciousCount.textContent = String(summary.suspiciousCount ?? 0);

  const pressure = hasPressure ? '检测到压力。' : '';
  const appServerText = `桌面 app-server ${codex.desktopAppServerCount ?? 0} 个，stdio app-server ${codex.stdioAppServerCount ?? 0} 个`;
  const groupText = `候选组 ${summary.candidateGroupCount ?? 0} 个，重复组 ${summary.duplicateGroupCount ?? 0} 个`;
  const detailText = `${summary.cleanableCount || 0} 个可清理，${summary.protectedCount || 0} 个保护中，${summary.suspiciousCount || 0} 个需确认。`;
  const memoryText = `候选私有 ${formatMB(summary.candidatePrivateMB)}，工作集 ${formatMB(summary.candidateWorkingSetMB)}。`;
  codexStatus.className = `codex-status ${hasCleanable ? 'is-actionable' : 'is-clear'} ${hasPressure ? 'is-pressure' : ''}`;
  codexStatus.textContent = statusText || `${pressure}${appServerText}，${groupText}，${detailText}${memoryText}`;

  renderGroupList(scan.candidateGroups);
  renderProcessList(codexCleanableList, scan.cleanable, '没有可清理的过期残留。');
  renderProcessList(codexProtectedList, scan.protected, '没有正在保护的 Codex 工具进程。');
  renderProcessList(codexSuspiciousList, scan.suspicious, '没有需要人工确认的进程。');
}

async function runCodexAction(action, options = {}) {
  for (const button of [codexScanButton, codexDryRunButton, codexCleanButton]) button.disabled = true;
  try {
    const actionText = { scan: '正在扫描', 'dry-run': '正在预演', clean: '正在清理' }[action] || '处理中';
    codexStatus.className = 'codex-status is-busy';
    codexStatus.textContent = `${actionText}...`;
    if (action === 'scan') {
      renderCodexScan(await window.memguard.codexScan(options.force !== false), '扫描完成。');
    } else if (action === 'dry-run') {
      const result = await window.memguard.codexCleanDryRun();
      renderCodexScan(result.before, `预演完成。将清理 ${result.targetCount || 0} 个目标。`);
      await refresh();
    } else if (action === 'clean') {
      const confirmed = window.confirm('清理 Codex Desktop 下旧的重复 MCP/node/cmd 工具链？最新工具链、dev server、Chrome 和当前会话会被保护。');
      if (!confirmed) {
        codexStatus.textContent = '已取消清理。';
        return;
      }
      const result = await window.memguard.codexClean();
      renderCodexScan(result.after, `清理完成。已结束 ${result.killedCount || 0} 个，失败 ${result.failedCount || 0} 个。`);
      await refresh();
    }
  } catch (error) {
    codexStatus.className = 'codex-status is-error';
    codexStatus.textContent = error && error.message ? error.message : String(error);
  } finally {
    for (const button of [codexScanButton, codexDryRunButton, codexCleanButton]) button.disabled = false;
  }
}

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveState.textContent = '正在保存...';
  const config = await window.memguard.saveConfig(formConfig());
  fillForm(config);
  saveState.textContent = '已保存';
  setTimeout(() => {
    saveState.textContent = '';
  }, 1800);
});

refreshButton.addEventListener('click', refresh);
cleanButton.addEventListener('click', async () => {
  cleanButton.disabled = true;
  cleanButton.textContent = '清理中...';
  try {
    await window.memguard.trimNow();
    await refresh();
  } finally {
    cleanButton.disabled = false;
    cleanButton.textContent = '立即清理';
  }
});

document.getElementById('openLogsButton').addEventListener('click', () => window.memguard.openLogs());
document.getElementById('openHistoryButton').addEventListener('click', () => window.memguard.openHistory());
document.getElementById('openConfigButton').addEventListener('click', () => window.memguard.openConfig());
codexScanButton.addEventListener('click', () => runCodexAction('scan', { force: true }));
codexDryRunButton.addEventListener('click', () => runCodexAction('dry-run'));
codexCleanButton.addEventListener('click', () => runCodexAction('clean'));
minimizeWindow.addEventListener('click', () => window.memguard.dashboardWindow('minimize'));
closeWindow.addEventListener('click', () => window.memguard.dashboardWindow('close'));

refresh().then(() => {
  setTimeout(() => runCodexAction('scan', { force: false }), 900);
});
