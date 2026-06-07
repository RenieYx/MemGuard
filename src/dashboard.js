const usedPercent = document.getElementById('usedPercent');
const freeGB = document.getElementById('freeGB');
const selfWorkingSet = document.getElementById('selfWorkingSet');
const selfUsageDetail = document.getElementById('selfUsageDetail');
const lastTrim = document.getElementById('lastTrim');
const meterFill = document.getElementById('meterFill');
const subtitle = document.getElementById('subtitle');
const settingsForm = document.getElementById('settingsForm');
const saveState = document.getElementById('saveState');
const saveButton = settingsForm.querySelector('button[type="submit"]');
const applyLowResourceButton = document.getElementById('applyLowResourceButton');
const historyList = document.getElementById('historyList');
const refreshButton = document.getElementById('refreshButton');
const trimPlanButton = document.getElementById('trimPlanButton');
const cleanButton = document.getElementById('cleanButton');
const rescueButton = document.getElementById('rescueButton');
const minimizeWindow = document.getElementById('minimizeWindow');
const closeWindow = document.getElementById('closeWindow');
const actionStatus = document.getElementById('actionStatus');
const trimPlanStatus = document.getElementById('trimPlanStatus');
const pressureActionBar = document.getElementById('pressureActionBar');
const pressureActionLabel = document.getElementById('pressureActionLabel');
const pressureActionTitle = document.getElementById('pressureActionTitle');
const pressureActionDetail = document.getElementById('pressureActionDetail');
const pressureActionHint = document.getElementById('pressureActionHint');

const codexScanButton = document.getElementById('codexScanButton');
const codexDryRunButton = document.getElementById('codexDryRunButton');
const codexCleanButton = document.getElementById('codexCleanButton');
const codexRescueButton = document.getElementById('codexRescueButton');
const codexRunning = document.getElementById('codexRunning');
const codexCandidates = document.getElementById('codexCandidates');
const codexCandidateMemory = document.getElementById('codexCandidateMemory');
const codexCleanable = document.getElementById('codexCleanable');
const codexCommit = document.getElementById('codexCommit');
const codexStatus = document.getElementById('codexStatus');
const pressureLevel = document.getElementById('pressureLevel');
const pressureDetail = document.getElementById('pressureDetail');
const nextSnapshotInterval = document.getElementById('nextSnapshotInterval');
const scheduleDetail = document.getElementById('scheduleDetail');
const codexGroupMeta = document.getElementById('codexGroupMeta');
const codexGroupList = document.getElementById('codexGroupList');
const codexCleanableCount = document.getElementById('codexCleanableCount');
const codexProtectedCount = document.getElementById('codexProtectedCount');
const codexSuspiciousCount = document.getElementById('codexSuspiciousCount');
const codexCleanableList = document.getElementById('codexCleanableList');
const codexProtectedList = document.getElementById('codexProtectedList');
const codexSuspiciousList = document.getElementById('codexSuspiciousList');

let currentConfig = {};
let settingsDirty = false;
let restartRequiredAfterSave = false;

const safePressureLevels = new Set(['normal', 'watch', 'pressure', 'critical']);
const restartRequiredFields = new Set([
  'disableHardwareAcceleration'
]);

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
    memoryMode: data.get('memoryMode'),
    historyLimit: Number(data.get('historyLimit')),
    trimOnStart: settingsForm.elements.trimOnStart.checked,
    lowResourceMode: settingsForm.elements.lowResourceMode.checked,
    showWidgetOnStart: settingsForm.elements.showWidgetOnStart.checked,
    disableHardwareAcceleration: settingsForm.elements.disableHardwareAcceleration.checked,
    adaptiveCheckIntervalEnabled: settingsForm.elements.adaptiveCheckIntervalEnabled.checked,
    codexGuardEnabled: settingsForm.elements.codexGuardEnabled.checked,
    codexAutoCleanAfterCodexExit: settingsForm.elements.codexAutoCleanAfterCodexExit.checked,
    codexAutoCleanWhileRunning: settingsForm.elements.codexAutoCleanWhileRunning.checked,
    codexDryRunByDefault: settingsForm.elements.codexDryRunByDefault.checked,
    codexCleanWhileRunning: data.get('codexCleanWhileRunning'),
    codexStaleMinutes: Number(data.get('codexStaleMinutes')),
    codexMaxMcpProcesses: Number(data.get('codexMaxMcpProcesses')),
    codexCommitPressurePercent: Number(data.get('codexCommitPressurePercent')),
    codexScanIntervalSeconds: Number(data.get('codexScanIntervalSeconds')),
    codexAutoCleanWhileRunningCooldownMinutes: Number(data.get('codexAutoCleanWhileRunningCooldownMinutes')),
    codexAutoCleanWhileRunningMaxKillsPerPass: Number(data.get('codexAutoCleanWhileRunningMaxKillsPerPass'))
  };
}

function configValueChanged(name, nextConfig = formConfig(), previousConfig = currentConfig) {
  return String(nextConfig[name]) !== String(previousConfig[name]);
}

function hasRestartRequiredChange(nextConfig = formConfig(), previousConfig = currentConfig) {
  for (const field of restartRequiredFields) {
    if (configValueChanged(field, nextConfig, previousConfig)) return true;
  }
  return false;
}

function refreshSaveState() {
  if (!settingsDirty) return;
  const restartText = hasRestartRequiredChange() ? '，其中有设置需重启后生效' : '';
  saveState.textContent = `未保存${restartText}`;
}

function setActionStatus(message, kind = 'info') {
  if (!actionStatus) return;
  actionStatus.textContent = message || '';
  actionStatus.className = message ? `action-status is-${kind}` : 'action-status';
}

function setTrimPlanStatus(message, kind = 'info') {
  if (!trimPlanStatus) return;
  trimPlanStatus.textContent = message || '';
  trimPlanStatus.className = message ? `action-status trim-plan-status is-${kind}` : 'action-status trim-plan-status';
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

function pressureReasonText(reason) {
  if (!reason) return '';
  const text = String(reason);
  const [kind, value] = text.split(':');
  const map = {
    'physical-pressure': `物理内存 ${value || ''}`,
    'commit-pressure': `提交内存 ${value || ''}`,
    'free-pressure': `可用内存 ${value || ''}`,
    'process-pressure': `进程数量 ${value || ''}`,
    'codex-pressure': `Codex 候选 ${value || ''}`
  };
  return map[kind] || text;
}

function pressureAdvice(level, snapshot) {
  const reasons = Array.isArray(snapshot.pressureReasons)
    ? snapshot.pressureReasons.map(pressureReasonText).filter(Boolean).slice(0, 2)
    : [];
  const suffix = reasons.length ? ` (${reasons.join(' / ')})` : '';
  const map = {
    normal: `状态平稳，无需处理${suffix}`,
    watch: `开始吃紧，先观察；旧工具链会优先进入预演${suffix}`,
    pressure: `内存压力偏高，建议先预演或立即清理${suffix}`,
    critical: `压力危险，建议使用强制抢救并关闭大型应用${suffix}`
  };
  if (map[level]) return map[level];
  const score = Number(snapshot.pressureScore || 0);
  const commit = snapshot.commitPercent == null ? '未知' : `${Number(snapshot.commitPercent).toFixed(1)}%`;
  return `压力评分 ${score} / 提交内存 ${commit}`;
}

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)}%` : '--';
}

function formatGB(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)} GB` : '--';
}

function rescuePressureSummary(snapshot = {}) {
  const rawLevel = snapshot.pressureLevel || 'normal';
  const level = safePressureLevels.has(rawLevel) ? rawLevel : 'normal';
  const reasons = Array.isArray(snapshot.pressureReasons)
    ? snapshot.pressureReasons.map(pressureReasonText).filter(Boolean).slice(0, 3)
    : [];
  const reasonText = reasons.length
    ? reasons.join(' / ')
    : level === 'normal' ? '暂无明显压力，建议只在卡顿时使用' : '压力来源仍在采样中';
  return {
    level,
    label: pressureText(level),
    reasonText,
    line: `当前压力：${pressureText(level)}，已用 ${formatPercent(snapshot.usedPercent)}，可用 ${formatGB(snapshot.freeGB)}，提交 ${formatPercent(snapshot.commitPercent)}。`
  };
}

function buildRescueConfirmMessage(context = {}) {
  const state = context.state || {};
  const scan = context.scan || {};
  const snapshot = state.snapshot || scan.snapshot || {};
  const config = state.config || currentConfig || {};
  const summary = scan.summary || {};
  const pressure = rescuePressureSummary(snapshot);
  const maxKills = Math.max(48, Number(config.codexAutoCleanWhileRunningMaxKillsPerPass || 48));
  const cleanable = Number(summary.cleanableCount || 0);
  const protectedCount = Number(summary.protectedCount || 0);
  const suspicious = Number(summary.suspiciousCount || 0);
  const candidatePrivate = formatMB(summary.candidatePrivateMB);
  const candidateWorkingSet = formatMB(summary.candidateWorkingSetMB);
  const scanLine = context.scanError
    ? `Codex 候选：扫描失败（${context.scanError.message || context.scanError}），仍可继续执行强制抢救。`
    : `Codex 候选：${cleanable} 个可清理，${protectedCount} 个保护中，${suspicious} 个需确认；候选私有 ${candidatePrivate}，工作集 ${candidateWorkingSet}。`;

  return [
    '强制抢救会立即执行两步：',
    `1. 清理 Codex 过期/重复工具链（本轮最多 ${maxKills} 个）。`,
    '2. 使用高强度策略修剪大工作集进程。',
    '',
    pressure.line,
    `压力原因：${pressure.reasonText}。`,
    scanLine,
    '',
    '最新工具链、dev server、Chrome 和当前会话会被保护。继续？'
  ].join('\n');
}

async function getRescueContext() {
  const state = await window.memguard.getDashboardState();
  let scan = state.codexScanCache && state.codexScanCache.result ? state.codexScanCache.result : null;
  let scanError = null;
  if (!scan) {
    try {
      scan = await window.memguard.codexScan(false);
    } catch (error) {
      scanError = error;
    }
  }
  return { state, scan, scanError };
}

async function confirmRescueAction(setBusy, setCancelled) {
  if (typeof setBusy === 'function') setBusy('正在读取当前压力与 Codex 候选...');
  let context = {};
  try {
    context = await getRescueContext();
  } catch (error) {
    context = { scanError: error };
  }
  const confirmed = window.confirm(buildRescueConfirmMessage(context));
  if (!confirmed && typeof setCancelled === 'function') setCancelled();
  return confirmed;
}

function renderHistory(history) {
  historyList.innerHTML = '';
  if (!history.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有清理记录。执行立即清理、Codex 预演或清理残留后会显示在这里。';
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
      const dryRunText = item.reason === 'codex-dry-run' ? '，未实际结束进程' : '';
      detail.textContent = `${reasonText(item.reason)}${dryRunText} / 目标 ${item.targetCount ?? 0} / 已结束 ${item.killedCount ?? 0}`;
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

function pressureText(level) {
  const map = {
    normal: '正常',
    watch: '观察',
    pressure: '高压',
    critical: '抢救'
  };
  return map[level] || level || '--';
}

function renderPressure(snapshot) {
  const rawLevel = snapshot.pressureLevel || 'normal';
  const level = safePressureLevels.has(rawLevel) ? rawLevel : 'normal';
  const detail = pressureAdvice(level, snapshot);
  pressureLevel.textContent = pressureText(level);
  pressureDetail.textContent = detail;
  pressureLevel.closest('.metric').className = `metric pressure-card pressure-${level}`;
}

function setRecommendedButtons(action) {
  const buttons = [trimPlanButton, cleanButton, rescueButton, codexScanButton, codexDryRunButton, codexCleanButton, codexRescueButton];
  for (const button of buttons) {
    if (button) button.classList.remove('button-recommended');
  }
  const targets = {
    codexScan: [codexScanButton],
    trimPlan: [trimPlanButton],
    codexDryRun: [codexDryRunButton],
    clean: [cleanButton],
    rescue: [rescueButton, codexRescueButton]
  }[action] || [];
  for (const button of targets) {
    if (button) button.classList.add('button-recommended');
  }
}

function buildPressureAction(state = {}) {
  const snapshot = state.snapshot || {};
  const rawLevel = snapshot.pressureLevel || 'normal';
  const level = safePressureLevels.has(rawLevel) ? rawLevel : 'normal';
  const cache = state.codexScanCache && state.codexScanCache.result ? state.codexScanCache.result : null;
  const summary = cache && cache.summary ? cache.summary : {};
  const cleanable = Number(summary.cleanableCount || 0);
  const protectedCount = Number(summary.protectedCount || 0);
  const candidatePrivate = Number(summary.candidatePrivateMB || 0);
  const age = state.codexScanCache ? Number(state.codexScanCache.ageSeconds || 0) : null;
  const codexText = cache
    ? `Codex 可清理 ${cleanable} 个，保护 ${protectedCount} 个，候选私有 ${formatMB(candidatePrivate)}${age == null ? '' : `，缓存 ${age} 秒`}`
    : 'Codex 候选未扫描，后台会按低资源策略延后刷新';
  const reasons = Array.isArray(snapshot.pressureReasons)
    ? snapshot.pressureReasons.map(pressureReasonText).filter(Boolean).slice(0, 2)
    : [];
  const reasonText = reasons.length ? `压力来源：${reasons.join(' / ')}` : `已用 ${formatPercent(snapshot.usedPercent)}，可用 ${formatGB(snapshot.freeGB)}`;

  if (level === 'critical') {
    return {
      level,
      action: 'rescue',
      title: '压力危险，建议确认后强制抢救',
      detail: `${reasonText}。${codexText}。`,
      hint: '推荐：强制抢救'
    };
  }
  if (level === 'pressure') {
    if (!cache) {
      return {
        level,
        action: 'codexScan',
        title: '压力偏高，先刷新 Codex 扫描',
        detail: `${reasonText}。${codexText}。`,
        hint: '推荐：扫描'
      };
    }
    return {
      level,
      action: cleanable > 0 ? 'codexDryRun' : 'trimPlan',
      title: cleanable > 0 ? '压力偏高，先预演 Codex 残留' : '压力偏高，先预演普通清理',
      detail: `${reasonText}。${codexText}。`,
      hint: cleanable > 0 ? '推荐：Codex 预演' : '推荐：预演清理'
    };
  }
  if (level === 'watch') {
    if (!cache) {
      return {
        level,
        action: 'codexScan',
        title: '开始吃紧，先刷新 Codex 扫描',
        detail: `${reasonText}。${codexText}。`,
        hint: '推荐：扫描'
      };
    }
    return {
      level,
      action: cleanable > 0 ? 'codexDryRun' : '',
      title: cleanable > 0 ? '开始吃紧，先看 Codex 预演' : '开始吃紧，继续观察',
      detail: `${reasonText}。${codexText}。`,
      hint: cleanable > 0 ? '推荐：Codex 预演' : '推荐：观察'
    };
  }
  if (cleanable > 0) {
    return {
      level,
      action: 'codexDryRun',
      title: '内存平稳，但发现可预演的 Codex 残留',
      detail: `${codexText}。当前无需强制处理，可先预演确认。`,
      hint: '推荐：Codex 预演'
    };
  }
  return {
    level,
    action: '',
    title: '状态平稳，保持低资源后台守护',
    detail: `${reasonText}。${codexText}。`,
    hint: '推荐：观察'
  };
}

function renderPressureAction(state) {
  if (!pressureActionBar) return;
  const action = buildPressureAction(state);
  pressureActionBar.className = `pressure-action-bar pressure-action-${action.level}`;
  pressureActionLabel.textContent = '处置建议';
  pressureActionTitle.textContent = action.title;
  pressureActionDetail.textContent = action.detail;
  pressureActionHint.textContent = action.hint;
  setRecommendedButtons(action.action);
}

function renderState(state) {
  const snapshot = state.snapshot || {};
  const selfUsage = state.selfUsage || {};
  const percent = Number(snapshot.usedPercent || 0);
  currentConfig = state.config || {};
  usedPercent.textContent = `${percent.toFixed(1)}%`;
  freeGB.textContent = `${Number(snapshot.freeGB || 0).toFixed(1)} GB`;
  if (selfUsage.error) {
    selfWorkingSet.textContent = '-- MB';
    selfUsageDetail.textContent = '采样失败';
  } else {
    selfWorkingSet.textContent = `${Number(selfUsage.totalWorkingSetMB || 0).toFixed(0)} MB`;
    selfUsageDetail.textContent = `工作集 / 私有 ${Number(selfUsage.totalPrivateMB || 0).toFixed(0)} MB · ${Number(selfUsage.processCount || 0)} 进程`;
  }
  lastTrim.textContent = lastText(snapshot.lastTrim);
  meterFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  renderPressure(snapshot);
  renderPressureAction(state);
  const intervalSeconds = Number(state.nextSnapshotIntervalSeconds || currentConfig.checkSeconds || 0);
  nextSnapshotInterval.textContent = intervalSeconds ? `${intervalSeconds} 秒` : '-- 秒';
  scheduleDetail.textContent = currentConfig.adaptiveCheckIntervalEnabled === false
    ? '固定间隔'
    : `${pressureText(snapshot.pressureLevel)} 自适应`;
  subtitle.textContent = state.pausedUntil && Date.now() < state.pausedUntil
    ? '自动清理已暂停'
    : `${pressureText(snapshot.pressureLevel)} / ${currentConfig.memoryMode === 'aggressive' ? '高强度智能' : '均衡'}模式`;
  if (!settingsDirty) {
    fillForm(state.config || {});
  }
  renderHistory(state.history || []);
}

function renderTrimPlan(planResult) {
  const plan = planResult && planResult.trimPlan ? planResult.trimPlan : {};
  const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
  const selected = Number(plan.selectedCandidateCount || candidates.length || 0);
  const skipped = Array.isArray(plan.skippedSensitiveProcesses)
    ? plan.skippedSensitiveProcesses.length
    : Number(plan.skippedSensitiveProcessCount || plan.skippedSensitiveProcesses || 0);
  const raw = Number(plan.rawCandidateCount || 0);
  const preview = candidates.slice(0, 3).map((item) => {
    const name = item.name || item.processName || '进程';
    const pid = item.pid || item.id || '--';
    const mb = formatMB(item.workingSetBeforeMB || item.workingSetMB || item.privateBeforeMB || item.privateMB || item.memoryMB || 0);
    return `${name} #${pid} ${mb}`;
  }).join('；');
  setTrimPlanStatus(selected
    ? `普通清理预演完成：原始候选 ${raw} 个，将修剪 ${selected} 个，已跳过敏感进程 ${skipped} 个。${preview ? `候选示例：${preview}` : ''}`
    : `普通清理预演完成：当前没有合适的修剪目标，已跳过敏感进程 ${skipped} 个。`, selected ? 'actionable' : 'clear');
}

async function refresh() {
  const state = await window.memguard.getDashboardState();
  renderState(state);
  return state;
}

function renderCachedCodexScan(cache) {
  if (cache && cache.result) {
    const age = Number(cache.ageSeconds || 0);
    const statusText = `已显示最近一次 Codex 扫描缓存，约 ${age} 秒前更新。点击“扫描”可立即刷新。`;
    renderCodexScan(cache.result, statusText);
    return;
  }
  codexStatus.className = 'codex-status is-clear';
  codexStatus.textContent = '已加载基础状态。Codex 守护会在后台按间隔扫描；需要查看当前候选时可手动点击“扫描”。';
}

function setCheckbox(name, checked) {
  const field = settingsForm.elements[name];
  if (field) field.checked = Boolean(checked);
}

function setFieldValue(name, value) {
  const field = settingsForm.elements[name];
  if (field) field.value = value;
}

function applyLowResourceProfile() {
  setCheckbox('trimOnStart', false);
  setCheckbox('lowResourceMode', true);
  setCheckbox('showWidgetOnStart', false);
  setCheckbox('disableHardwareAcceleration', true);
  setCheckbox('adaptiveCheckIntervalEnabled', true);
  setCheckbox('codexGuardEnabled', true);
  setCheckbox('codexAutoCleanAfterCodexExit', true);
  setCheckbox('codexAutoCleanWhileRunning', true);
  setCheckbox('codexDryRunByDefault', true);
  setFieldValue('memoryMode', 'aggressive');
  setFieldValue('codexCleanWhileRunning', 'allow-stale');
  setFieldValue('codexAutoCleanWhileRunningCooldownMinutes', 3);
  setFieldValue('codexAutoCleanWhileRunningMaxKillsPerPass', 48);
  settingsDirty = true;
  restartRequiredAfterSave = hasRestartRequiredChange();
  saveState.textContent = restartRequiredAfterSave
    ? '低资源推荐已填入，保存并重启后完整生效'
    : '低资源推荐已填入，保存后生效';
  setActionStatus('已套用低资源推荐值：隐藏小窗释放窗口、默认禁用 GPU、拉长后台扫描。请保存设置。', 'busy');
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
  const actionText = hasCleanable
    ? '建议先预演，确认后清理残留。'
    : hasPressure ? '暂未发现明确可清理项，继续观察。' : '当前无需处理。';
  const appServerText = `桌面 app-server ${codex.desktopAppServerCount ?? 0} 个，stdio app-server ${codex.stdioAppServerCount ?? 0} 个`;
  const groupText = `候选组 ${summary.candidateGroupCount ?? 0} 个，重复组 ${summary.duplicateGroupCount ?? 0} 个`;
  const detailText = `${summary.cleanableCount || 0} 个可清理，${summary.protectedCount || 0} 个保护中，${summary.suspiciousCount || 0} 个需确认。`;
  const memoryText = `候选私有 ${formatMB(summary.candidatePrivateMB)}，工作集 ${formatMB(summary.candidateWorkingSetMB)}。`;
  codexStatus.className = `codex-status ${hasCleanable ? 'is-actionable' : 'is-clear'} ${hasPressure ? 'is-pressure' : ''}`;
  codexStatus.textContent = statusText || `${pressure}${detailText}${actionText}${appServerText}，${groupText}，${memoryText}`;
  renderPressureAction({
    snapshot,
    config: currentConfig,
    codexScanCache: { result: scan, ageSeconds: 0 }
  });

  renderGroupList(scan.candidateGroups);
  renderProcessList(codexCleanableList, scan.cleanable, '没有可清理的过期残留。');
  renderProcessList(codexProtectedList, scan.protected, '没有正在保护的 Codex 工具进程。');
  renderProcessList(codexSuspiciousList, scan.suspicious, '没有需要人工确认的进程。');
}

async function runCodexAction(action, options = {}) {
  for (const button of [codexScanButton, codexDryRunButton, codexCleanButton, codexRescueButton]) button.disabled = true;
  try {
    const actionText = { scan: '正在扫描', 'dry-run': '正在预演', clean: '正在清理', rescue: '正在抢救' }[action] || '处理中';
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
      if (result.dryRun) {
        renderCodexScan(result.before, `预演完成。默认预演已开启，将清理 ${result.targetCount || 0} 个目标。`);
      } else {
        renderCodexScan(result.after, `清理完成。已结束 ${result.killedCount || 0} 个，失败 ${result.failedCount || 0} 个。`);
      }
      await refresh();
    } else if (action === 'rescue') {
      const confirmed = await confirmRescueAction(
        (message) => {
          codexStatus.className = 'codex-status is-busy';
          codexStatus.textContent = message;
        },
        () => {
          codexStatus.textContent = '已取消强制抢救。';
        }
      );
      if (!confirmed) {
        return;
      }
      const result = await window.memguard.rescueNow();
      const killed = result.codex ? result.codex.killedCount || 0 : 0;
      const trimmed = result.trim ? result.trim.trimmedProcesses || 0 : 0;
      const freed = result.trim ? Number(result.trim.freedGB || 0).toFixed(2) : '0.00';
      const scan = result.codex && result.codex.after ? result.codex.after : await window.memguard.codexScan(true);
      renderCodexScan(scan, `抢救完成。结束 ${killed} 个工具进程，修剪 ${trimmed} 个进程，释放约 ${freed} GB。`);
      await refresh();
    }
  } catch (error) {
    codexStatus.className = 'codex-status is-error';
    codexStatus.textContent = error && error.message ? error.message : String(error);
  } finally {
    for (const button of [codexScanButton, codexDryRunButton, codexCleanButton, codexRescueButton]) button.disabled = false;
  }
}

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (saveButton.disabled) return;
  const nextConfig = formConfig();
  restartRequiredAfterSave = hasRestartRequiredChange(nextConfig, currentConfig);
  saveButton.disabled = true;
  saveState.textContent = '正在保存...';
  try {
    const config = await window.memguard.saveConfig(nextConfig);
    settingsDirty = false;
    currentConfig = config;
    fillForm(config);
    saveState.textContent = restartRequiredAfterSave ? '已保存，重启后完整生效' : '已保存';
    setActionStatus(restartRequiredAfterSave
      ? '设置已保存。禁用 GPU 加速这类启动项会在下次重启 MemGuard 后完整生效。'
      : '设置已保存，新的清理和扫描策略已写入配置。',
    restartRequiredAfterSave ? 'busy' : 'clear');
    setTimeout(() => {
      if (!settingsDirty) saveState.textContent = '';
    }, 1800);
  } catch (error) {
    saveState.textContent = error && error.message ? error.message : String(error);
    setActionStatus(saveState.textContent, 'error');
  } finally {
    saveButton.disabled = false;
  }
});

settingsForm.addEventListener('input', () => {
  settingsDirty = true;
  refreshSaveState();
});

settingsForm.addEventListener('change', () => {
  settingsDirty = true;
  refreshSaveState();
});

refreshButton.addEventListener('click', refresh);
applyLowResourceButton.addEventListener('click', applyLowResourceProfile);
trimPlanButton.addEventListener('click', async () => {
  trimPlanButton.disabled = true;
  trimPlanButton.textContent = '预演中...';
  setTrimPlanStatus('正在生成普通内存清理计划，不会实际修剪进程...', 'busy');
  setActionStatus('正在预演普通内存清理计划，不会实际修剪进程。', 'busy');
  try {
    const result = await window.memguard.trimPlan();
    renderTrimPlan(result);
    const plan = result && result.trimPlan ? result.trimPlan : {};
    const selected = Number(plan.selectedCandidateCount || 0);
    const skipped = Number(plan.skippedSensitiveProcessCount || 0);
    setActionStatus(`预演完成：预计可修剪 ${selected} 个进程，已跳过敏感进程 ${skipped} 个。`, selected ? 'actionable' : 'clear');
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    setTrimPlanStatus(message, 'error');
    setActionStatus(message, 'error');
  } finally {
    trimPlanButton.disabled = false;
    trimPlanButton.textContent = '预演清理';
  }
});
cleanButton.addEventListener('click', async () => {
  cleanButton.disabled = true;
  cleanButton.textContent = '清理中...';
  setActionStatus('正在执行普通内存清理...', 'busy');
  try {
    const result = await window.memguard.trimNow();
    if (result) {
      setActionStatus(`清理完成：修剪 ${result.trimmedProcesses || 0} 个进程，释放约 ${Number(result.freedGB || 0).toFixed(2)} GB。`, 'clear');
    } else {
      setActionStatus('清理已结束，但未返回详细结果；可以打开日志查看。', 'busy');
    }
    await refresh();
  } catch (error) {
    setActionStatus(error && error.message ? error.message : String(error), 'error');
  } finally {
    cleanButton.disabled = false;
    cleanButton.textContent = '立即清理';
  }
});
rescueButton.addEventListener('click', async () => {
  rescueButton.disabled = true;
  rescueButton.textContent = '读取中...';
  const confirmed = await confirmRescueAction(
    (message) => setActionStatus(message, 'busy'),
    () => setActionStatus('已取消强制抢救。', 'busy')
  );
  if (!confirmed) {
    rescueButton.disabled = false;
    rescueButton.textContent = '强制抢救';
    return;
  }
  rescueButton.textContent = '抢救中...';
  setActionStatus('正在执行强制抢救：先处理过期 Codex 工具链，再执行高强度内存修剪。', 'busy');
  try {
    const result = await window.memguard.rescueNow();
    const killed = result && result.codex ? result.codex.killedCount || 0 : 0;
    const failed = result && result.codex ? result.codex.failedCount || 0 : 0;
    const trimmed = result && result.trim ? result.trim.trimmedProcesses || 0 : 0;
    const freed = result && result.trim ? Number(result.trim.freedGB || 0).toFixed(2) : '0.00';
    setActionStatus(`强制抢救完成：结束 Codex 工具 ${killed} 个，失败 ${failed} 个；修剪 ${trimmed} 个进程，释放约 ${freed} GB。`, 'clear');
    await refresh();
  } catch (error) {
    codexStatus.className = 'codex-status is-error';
    codexStatus.textContent = error && error.message ? error.message : String(error);
    setActionStatus(codexStatus.textContent, 'error');
  } finally {
    rescueButton.disabled = false;
    rescueButton.textContent = '强制抢救';
  }
});

document.getElementById('openLogsButton').addEventListener('click', () => window.memguard.openLogs());
document.getElementById('openHistoryButton').addEventListener('click', () => window.memguard.openHistory());
document.getElementById('openConfigButton').addEventListener('click', () => window.memguard.openConfig());
codexScanButton.addEventListener('click', () => runCodexAction('scan', { force: true }));
codexDryRunButton.addEventListener('click', () => runCodexAction('dry-run'));
codexCleanButton.addEventListener('click', () => runCodexAction('clean'));
codexRescueButton.addEventListener('click', () => runCodexAction('rescue'));
minimizeWindow.addEventListener('click', () => window.memguard.dashboardWindow('minimize'));
closeWindow.addEventListener('click', () => {
  if (settingsDirty && !window.confirm('设置还没有保存，关闭后这些改动会丢失。继续关闭？')) {
    return;
  }
  window.memguard.dashboardWindow('close');
});

refresh().then((state) => renderCachedCodexScan(state.codexScanCache));
