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
  lastTrim: '',
  statusOverride: '',
  statusOverrideUntil: 0,
  pressureLevel: 'normal',
  hasSnapshot: false
};

let animationFrame = 0;
let refreshTimer = 0;

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

function nextLastTrimDelay(now = Date.now()) {
  if (!state.lastTrim) return null;
  const then = new Date(state.lastTrim).getTime();
  if (!Number.isFinite(then)) return null;
  const diff = now - then;
  if (diff < 0) return 60_000;
  if (diff < 60_000) return 60_000 - diff + 50;
  if (diff < 3_600_000) return 60_000 - (diff % 60_000) + 50;
  return null;
}

function nextPaintDelay() {
  const now = Date.now();
  const candidates = [];
  if (state.statusOverride && now < state.statusOverrideUntil) {
    candidates.push(state.statusOverrideUntil - now + 50);
  }
  if (state.pausedUntil && now < state.pausedUntil) {
    candidates.push(state.pausedUntil - now + 50);
  }
  const trimDelay = nextLastTrimDelay(now);
  if (trimDelay != null) {
    candidates.push(trimDelay);
  }
  const next = Math.min(...candidates.filter((value) => Number.isFinite(value) && value > 0));
  return Number.isFinite(next) ? clamp(next, 250, 3_600_000) : null;
}

function scheduleNextPaint() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = 0;
  }
  const delay = nextPaintDelay();
  if (delay == null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = 0;
    paint();
    scheduleNextPaint();
  }, delay);
}

function pressureText(level) {
  const map = {
    normal: '正常',
    watch: '观察',
    pressure: '高压',
    critical: '抢救'
  };
  return map[level] || '--';
}

function paint() {
  const now = Date.now();
  const paused = Boolean(state.pausedUntil && now < state.pausedUntil);
  percent.textContent = state.hasSnapshot ? `${state.used.toFixed(1)}%` : '--%';
  free.textContent = state.hasSnapshot ? `可用 ${state.freeGB.toFixed(1)} GB` : '可用 -- GB';
  fill.style.width = state.hasSnapshot ? `${clamp(state.used, 0, 100)}%` : '0%';
  if (state.statusOverride && now < state.statusOverrideUntil) {
    last.textContent = state.statusOverride;
  } else if (paused) {
    last.textContent = '已暂停';
  } else if (state.pressureLevel && state.pressureLevel !== 'normal') {
    last.textContent = pressureText(state.pressureLevel);
  } else {
    last.textContent = lastText(state.lastTrim);
  }
  card.classList.toggle('paused', paused);
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
  if (Math.abs(state.targetUsed - state.used) >= 0.02) {
    animationFrame = requestAnimationFrame(animate);
  } else {
    animationFrame = 0;
  }
}

function startAnimation() {
  if (animationFrame) return;
  state.lastFrame = performance.now();
  animationFrame = requestAnimationFrame(animate);
}

function render(snapshot) {
  const used = Number(snapshot.usedPercent || 0);
  state.targetUsed = clamp(used, 0, 100);
  if (!state.hasSnapshot) {
    state.used = state.targetUsed;
    state.hasSnapshot = true;
  }
  state.freeGB = Number(snapshot.freeGB || 0);
  state.lastTrim = snapshot.lastTrim || state.lastTrim || '';
  state.pausedUntil = Number(snapshot.pausedUntil || state.pausedUntil || 0);
  state.pressureLevel = ['normal', 'watch', 'pressure', 'critical'].includes(snapshot.pressureLevel)
    ? snapshot.pressureLevel
    : used >= 85 ? 'pressure' : 'normal';
  if (!state.statusOverride || Date.now() >= state.statusOverrideUntil) {
    last.textContent = state.pausedUntil && Date.now() < state.pausedUntil
      ? '已暂停'
      : state.pressureLevel !== 'normal' ? pressureText(state.pressureLevel) : lastText(snapshot.lastTrim);
  }
  for (const level of ['watch', 'pressure', 'critical']) {
    card.classList.toggle(level, state.pressureLevel === level);
  }
  card.classList.toggle('high', used >= 85 || ['pressure', 'critical'].includes(state.pressureLevel));
  card.classList.toggle('paused', state.pausedUntil && Date.now() < state.pausedUntil);
  paint();
  startAnimation();
  scheduleNextPaint();
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
  scheduleNextPaint();
});

window.memguard.onCleaningState(setCleaning);

window.memguard.onPauseState((pausedUntil) => {
  state.pausedUntil = Number(pausedUntil || 0);
  state.statusOverride = state.pausedUntil && Date.now() < state.pausedUntil ? '已暂停' : '已恢复';
  state.statusOverrideUntil = Date.now() + 3000;
  card.classList.toggle('paused', state.pausedUntil && Date.now() < state.pausedUntil);
  scheduleNextPaint();
});

card.addEventListener('dblclick', cleanNow);
cleanButton.addEventListener('click', cleanNow);
card.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.memguard.showMenu();
});

window.memguard.getWidgetState()
  .then(render)
  .catch((error) => {
    state.statusOverride = error && error.message ? error.message : '快照失败';
    state.statusOverrideUntil = Date.now() + 5000;
    paint();
    scheduleNextPaint();
  });

paint();
scheduleNextPaint();
