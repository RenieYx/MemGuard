const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('memguard', {
  onSnapshot: (callback) => ipcRenderer.on('snapshot', (_event, data) => callback(data)),
  onTrimResult: (callback) => ipcRenderer.on('trim-result', (_event, data) => callback(data)),
  onError: (callback) => ipcRenderer.on('engine-error', (_event, message) => callback(message)),
  onCleaningState: (callback) => ipcRenderer.on('cleaning-state', (_event, cleaning) => callback(cleaning)),
  onPauseState: (callback) => ipcRenderer.on('pause-state', (_event, pausedUntil) => callback(pausedUntil)),
  trimNow: () => ipcRenderer.invoke('trim-now'),
  codexScan: (force = true) => ipcRenderer.invoke('codex-scan', force),
  codexCleanDryRun: () => ipcRenderer.invoke('codex-clean-dry-run'),
  codexClean: () => ipcRenderer.invoke('codex-clean'),
  showMenu: () => ipcRenderer.invoke('show-menu'),
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
  getDashboardState: () => ipcRenderer.invoke('dashboard-state'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  openHistory: () => ipcRenderer.invoke('open-history'),
  openConfig: () => ipcRenderer.invoke('open-config'),
  dashboardWindow: (action) => ipcRenderer.invoke('dashboard-window', action),
  hide: () => ipcRenderer.invoke('hide-window')
});
