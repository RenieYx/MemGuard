const { performance } = require('perf_hooks');
const { createFastSnapshot } = require('./system-snapshot');

const runs = Number(process.argv[2] || 1000);
const rows = [];
let lastSnapshot = null;

for (let index = 0; index < runs; index += 1) {
  const start = performance.now();
  lastSnapshot = createFastSnapshot({
    dataDir: process.cwd(),
    lastSnapshot,
    memoryMode: 'aggressive'
  });
  rows.push(performance.now() - start);
}

rows.sort((a, b) => a - b);
const avg = rows.reduce((sum, value) => sum + value, 0) / rows.length;
const percentile = (p) => rows[Math.min(rows.length - 1, Math.floor(rows.length * p))];

console.log(JSON.stringify({
  runs,
  avgMs: Number(avg.toFixed(4)),
  minMs: Number(rows[0].toFixed(4)),
  p50Ms: Number(percentile(0.5).toFixed(4)),
  p95Ms: Number(percentile(0.95).toFixed(4)),
  maxMs: Number(rows[rows.length - 1].toFixed(4)),
  sample: lastSnapshot
}, null, 2));
