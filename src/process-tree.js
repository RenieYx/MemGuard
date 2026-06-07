const { spawnSync } = require('child_process');
const path = require('path');

const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function runPowerShellJson(script) {
  const result = spawnSync(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `PowerShell failed with ${result.status}`).trim());
  }
  return parsePowerShellJson(result.stdout || '[]');
}

function parsePowerShellJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch (error) {
    const jsonLine = text.split(/\r?\n/).find((line) => /^[\[{]/.test(line.trim()));
    if (jsonLine) return JSON.parse(jsonLine.trim());
    throw error;
  }
}

function listProcesses() {
  const script = `
$rows = Get-CimInstance Win32_Process |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine, ExecutablePath, WorkingSetSize, PrivatePageCount
$rows | ConvertTo-Json -Depth 4 -Compress
`;
  return normalizeArray(runPowerShellJson(script));
}

function getProcessTree(rootPid, options = {}) {
  const safeRootPid = Number(rootPid);
  if (!Number.isInteger(safeRootPid) || safeRootPid <= 0) {
    throw new Error(`Invalid root pid: ${rootPid}`);
  }
  const excludedPids = new Set((options.excludePids || []).map((pid) => Number(pid)).filter(Number.isInteger));
  const all = listProcesses();
  const byPid = new Map();
  const children = new Map();
  for (const proc of all) {
    const processId = Number(proc.ProcessId);
    const parentProcessId = Number(proc.ParentProcessId);
    byPid.set(processId, proc);
    if (!children.has(parentProcessId)) children.set(parentProcessId, []);
    children.get(parentProcessId).push(proc);
  }

  const queue = [safeRootPid];
  const seen = new Set();
  const rows = [];
  while (queue.length) {
    const processId = queue.shift();
    if (seen.has(processId)) continue;
    seen.add(processId);
    const proc = byPid.get(processId);
    if (proc && !excludedPids.has(processId)) {
      rows.push({
        pid: Number(proc.ProcessId),
        parentPid: Number(proc.ParentProcessId),
        name: String(proc.Name || ''),
        executablePath: String(proc.ExecutablePath || ''),
        commandLine: String(proc.CommandLine || ''),
        workingSetMB: round(Number(proc.WorkingSetSize || 0) / 1024 / 1024),
        privateMB: round(Number(proc.PrivatePageCount || 0) / 1024 / 1024)
      });
    }
    for (const child of children.get(processId) || []) {
      queue.push(Number(child.ProcessId));
    }
  }
  return rows;
}

function summarizeProcessTree(processes) {
  const byType = {};
  for (const row of processes || []) {
    const type = classifyProcess(row);
    if (!byType[type]) byType[type] = { count: 0, workingSetMB: 0, privateMB: 0 };
    byType[type].count += 1;
    byType[type].workingSetMB += Number(row.workingSetMB || 0);
    byType[type].privateMB += Number(row.privateMB || 0);
  }
  for (const value of Object.values(byType)) {
    value.workingSetMB = round(value.workingSetMB);
    value.privateMB = round(value.privateMB);
  }
  return {
    processCount: Array.isArray(processes) ? processes.length : 0,
    totalWorkingSetMB: round((processes || []).reduce((sum, row) => sum + Number(row.workingSetMB || 0), 0)),
    totalPrivateMB: round((processes || []).reduce((sum, row) => sum + Number(row.privateMB || 0), 0)),
    byType
  };
}

function classifyProcess(row) {
  const commandLine = String(row && row.commandLine || '');
  if (/--type=gpu-process/i.test(commandLine)) return 'gpu';
  if (/--type=utility/i.test(commandLine)) return 'utility';
  if (/--type=renderer/i.test(commandLine)) return 'renderer';
  if (/--type=crashpad-handler/i.test(commandLine)) return 'crashpad';
  if (/electron/i.test(row && row.name || '') || /MemGuard/i.test(row && row.name || '')) return 'browser-main';
  if (/cmd\.exe/i.test(row && row.name || '')) return 'launcher';
  return 'other';
}

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function round(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

module.exports = {
  classifyProcess,
  getProcessTree,
  summarizeProcessTree
};
