const PRESSURE_LEVELS = new Set(['watch', 'pressure', 'critical']);

function numberOrFallback(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pressureLevel(snapshot = {}) {
  const level = String(snapshot.pressureLevel || 'normal');
  return PRESSURE_LEVELS.has(level) ? level : 'normal';
}

function isPressureActive(snapshot = {}, config = {}) {
  const triggerPercent = numberOrFallback(config.triggerPercent, 85);
  return PRESSURE_LEVELS.has(pressureLevel(snapshot))
    || numberOrFallback(snapshot.usedPercent, 0) >= triggerPercent;
}

function shouldCountHighCheck(snapshot = {}, config = {}) {
  const triggerPercent = numberOrFallback(config.triggerPercent, 85);
  const memoryMode = String(config.memoryMode || 'aggressive');
  const level = pressureLevel(snapshot);
  return numberOrFallback(snapshot.usedPercent, 0) >= triggerPercent
    || (memoryMode === 'aggressive' && PRESSURE_LEVELS.has(level));
}

function trimCooldownMs(snapshot = {}, config = {}) {
  const cooldownMinutes = Math.max(1, numberOrFallback(config.cooldownMinutes, 20));
  const baseMs = cooldownMinutes * 60 * 1000;
  const level = pressureLevel(snapshot);
  if (level === 'critical') return Math.min(60_000, baseMs);
  if (level === 'pressure') return Math.min(180_000, baseMs);
  return baseMs;
}

function shouldAutoTrim({ snapshot = {}, config = {}, highCount = 0, lastAutoTrim = 0, now = Date.now() } = {}) {
  const consecutiveHighChecks = Math.max(1, numberOrFallback(config.consecutiveHighChecks, 2));
  if (highCount < consecutiveHighChecks) return false;
  return now - numberOrFallback(lastAutoTrim, 0) > trimCooldownMs(snapshot, config);
}

function shouldSkipTrimAfterCodex({ snapshot = {}, config = {} } = {}) {
  return !shouldCountHighCheck(snapshot, config);
}

module.exports = {
  isPressureActive,
  shouldCountHighCheck,
  trimCooldownMs,
  shouldAutoTrim,
  shouldSkipTrimAfterCodex
};
