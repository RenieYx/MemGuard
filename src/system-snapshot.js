const fs = require('fs');
const os = require('os');
const path = require('path');

function round(value, digits = 1) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function bytesToGB(bytes) {
  return round(Number(bytes || 0) / (1024 ** 3), 2);
}

function readLastTrim(dataDir) {
  try {
    const raw = fs.readFileSync(path.join(dataDir, 'last-trim.txt'), 'utf8').trim();
    const date = new Date(raw);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  } catch {
    return null;
  }
}

function getMemoryPressure(snapshot) {
  let score = 0;
  const reasons = [];
  const used = Number(snapshot.usedPercent || 0);
  const commit = snapshot.commitPercent == null ? null : Number(snapshot.commitPercent || 0);
  const free = Number(snapshot.freeGB || 0);

  if (used >= 94) {
    score += 55;
    reasons.push(`physical-critical:${used}%`);
  } else if (used >= 88) {
    score += 38;
    reasons.push(`physical-pressure:${used}%`);
  } else if (used >= 78) {
    score += 20;
    reasons.push(`physical-watch:${used}%`);
  }

  if (commit != null && commit >= 92) {
    score += 55;
    reasons.push(`commit-critical:${commit}%`);
  } else if (commit != null && commit >= 82) {
    score += 36;
    reasons.push(`commit-pressure:${commit}%`);
  } else if (commit != null && commit >= 70) {
    score += 18;
    reasons.push(`commit-watch:${commit}%`);
  }

  if (free <= 0.8) {
    score += 45;
    reasons.push(`free-critical:${free}GB`);
  } else if (free <= 1.5) {
    score += 30;
    reasons.push(`free-pressure:${free}GB`);
  } else if (free <= 2.5) {
    score += 16;
    reasons.push(`free-watch:${free}GB`);
  }

  let level = 'normal';
  if (score >= 70 || used >= 94 || (commit != null && commit >= 92) || free <= 0.8) {
    level = 'critical';
  } else if (score >= 45 || used >= 88 || (commit != null && commit >= 82) || free <= 1.5) {
    level = 'pressure';
  } else if (score >= 20 || used >= 78 || (commit != null && commit >= 70) || free <= 2.5) {
    level = 'watch';
  }

  return {
    level,
    score: Math.min(100, score),
    reasons
  };
}

function createFastSnapshot({ dataDir, lastSnapshot = null, memoryMode = 'aggressive' } = {}) {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const totalGB = bytesToGB(totalBytes);
  const freeGB = bytesToGB(freeBytes);
  const usedGB = Math.max(0, round(totalGB - freeGB, 2));
  const usedPercent = totalGB > 0 ? round((usedGB / totalGB) * 100, 1) : 0;
  const prior = lastSnapshot || {};
  const cachedLastTrim = prior.lastTrim || null;
  const snapshot = {
    totalGB,
    freeGB,
    usedGB,
    usedPercent,
    commitUsedGB: prior.commitUsedGB ?? null,
    commitTotalGB: prior.commitTotalGB ?? null,
    commitPeakGB: prior.commitPeakGB ?? null,
    commitPercent: prior.commitPercent ?? null,
    systemCacheGB: prior.systemCacheGB ?? null,
    processCount: prior.processCount ?? null,
    handleCount: prior.handleCount ?? null,
    threadCount: prior.threadCount ?? null,
    memoryMode,
    lastTrim: cachedLastTrim || (dataDir ? readLastTrim(dataDir) : null),
    timestamp: new Date().toISOString()
  };
  const pressure = getMemoryPressure(snapshot);
  snapshot.pressureLevel = pressure.level;
  snapshot.pressureScore = pressure.score;
  snapshot.pressureReasons = pressure.reasons;
  snapshot.source = 'node-fast';
  return snapshot;
}

module.exports = {
  createFastSnapshot,
  getMemoryPressure
};
