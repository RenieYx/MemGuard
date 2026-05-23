const card = document.getElementById('card');
const percent = document.getElementById('percent');
const free = document.getElementById('free');
const last = document.getElementById('last');
const fill = document.getElementById('fill');
const cleanButton = document.getElementById('cleanButton');

const state = {
  used: 0,
  targetUsed: 0,
  freeGB: 0,
  lastFrame: performance.now(),
  cleaning: false,
  pausedUntil: 0,
  statusOverride: '',
  statusOverrideUntil: 0
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lastText(iso) {
  if (!iso) return '--';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '--';
  const diff = Date.now() - then;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  return new Date(then).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function paint() {
  percent.textContent = `${state.used.toFixed(1)}%`;
  free.textContent = `可用 ${state.freeGB.toFixed(1)} GB`;
  fill.style.width = `${clamp(state.used, 0, 100)}%`;
  if (state.statusOverride && Date.now() < state.statusOverrideUntil) {
    last.textContent = state.statusOverride;
  } else if (state.pausedUntil && Date.now() < state.pausedUntil) {
    last.textContent = '已暂停';
  }
}

function animate(now) {
  const elapsed = Math.min(80, now - state.lastFrame);
  state.lastFrame = now;

  const diff = state.targetUsed - state.used;
  if (Math.abs(diff) < 0.02) {
    state.used = state.targetUsed;
  } else {
    state.used += diff * clamp(elapsed / 260, 0.08, 0.28);
  }

  paint();
  requestAnimationFrame(animate);
}

function render(snapshot) {
  const used = Number(snapshot.usedPercent || 0);
  state.targetUsed = clamp(used, 0, 100);
  state.freeGB = Number(snapshot.freeGB || 0);
  state.pausedUntil = Number(snapshot.pausedUntil || state.pausedUntil || 0);
  if (!state.statusOverride || Date.now() >= state.statusOverrideUntil) {
    last.textContent = state.pausedUntil && Date.now() < state.pausedUntil ? '已暂停' : lastText(snapshot.lastTrim);
  }
  card.classList.toggle('high', used >= 85);
  card.classList.toggle('paused', state.pausedUntil && Date.now() < state.pausedUntil);
}

function setCleaning(cleaning) {
  state.cleaning = cleaning;
  card.classList.toggle('cleaning', cleaning);
  cleanButton.disabled = cleaning;
  cleanButton.textContent = cleaning ? '...' : '清理';
}

function showTrimFeedback(result) {
  if (!result || !result.after) return;
  const freed = Number(result.freedGB || 0);
  const trimmed = Number(result.trimmedProcesses || 0);
  state.statusOverride = freed >= 0.01 ? `+${freed.toFixed(2)} GB` : `${trimmed} 个应用`;
  state.statusOverrideUntil = Date.now() + 5000;
  card.classList.remove('feedback');
  void card.offsetWidth;
  card.classList.add('feedback');
  last.textContent = state.statusOverride;
  render(result.after);
}

async function cleanNow() {
  if (state.cleaning) return;
  setCleaning(true);
  try {
    const result = await window.memguard.trimNow();
    showTrimFeedback(result);
  } finally {
    setCleaning(false);
  }
}

window.memguard.onSnapshot(render);

window.memguard.onTrimResult((result) => {
  setCleaning(false);
  showTrimFeedback(result);
});

window.memguard.onError((message) => {
  state.statusOverride = message || '引擎错误';
  state.statusOverrideUntil = Date.now() + 5000;
  last.textContent = state.statusOverride;
});

window.memguard.onCleaningState(setCleaning);

window.memguard.onPauseState((pausedUntil) => {
  state.pausedUntil = Number(pausedUntil || 0);
  state.statusOverride = state.pausedUntil && Date.now() < state.pausedUntil ? '已暂停' : '已恢复';
  state.statusOverrideUntil = Date.now() + 3000;
  card.classList.toggle('paused', state.pausedUntil && Date.now() < state.pausedUntil);
});

card.addEventListener('dblclick', cleanNow);
cleanButton.addEventListener('click', cleanNow);
card.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.memguard.showMenu();
});
requestAnimationFrame(animate);
