const { contextBridge, ipcRenderer } = require('electron');

const commonApi = {
  trimNow: () => ipcRenderer.invoke('trim-now'),
  trimPlan: () => ipcRenderer.invoke('trim-plan'),
  onError: (callback) => ipcRenderer.on('engine-error', (_event, message) => callback(message))
};

const widgetApi = {
  onSnapshot: (callback) => ipcRenderer.on('snapshot', (_event, data) => callback(data)),
  onTrimResult: (callback) => ipcRenderer.on('trim-result', (_event, data) => callback(data)),
  onCleaningState: (callback) => ipcRenderer.on('cleaning-state', (_event, cleaning) => callback(cleaning)),
  onPauseState: (callback) => ipcRenderer.on('pause-state', (_event, pausedUntil) => callback(pausedUntil)),
  getWidgetState: () => ipcRenderer.invoke('widget-state'),
  showMenu: () => ipcRenderer.invoke('show-menu')
};

const dashboardApi = {
  codexScan: (force = true) => ipcRenderer.invoke('codex-scan', force),
  codexCleanDryRun: () => ipcRenderer.invoke('codex-clean-dry-run'),
  codexClean: () => ipcRenderer.invoke('codex-clean'),
  rescueNow: () => ipcRenderer.invoke('rescue-now'),
  getDashboardState: () => ipcRenderer.invoke('dashboard-state'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  openHistory: () => ipcRenderer.invoke('open-history'),
  openConfig: () => ipcRenderer.invoke('open-config'),
  dashboardWindow: (action) => ipcRenderer.invoke('dashboard-window', action)
};

const page = location.pathname.replace(/\\/g, '/').split('/').pop();
const pageApi = page === 'dashboard.html' ? dashboardApi : widgetApi;

contextBridge.exposeInMainWorld('memguard', {
  ...commonApi,
  ...pageApi
});
