const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('storeListen', {
  getAppConfig: () => ipcRenderer.invoke('app-config'),
  getAppVersion: () => ipcRenderer.invoke('app-version'),
  request: (options) => ipcRenderer.invoke('api-request', options),
  uploadAudio: (payload) => ipcRenderer.invoke('audio-upload', payload),
  previewAudio: (payload) => ipcRenderer.invoke('audio-preview', payload),
  exportTranscriptPdf: (payload) => ipcRenderer.invoke('export-transcript-pdf', payload),
  loadTranscripts: () => ipcRenderer.invoke('load-transcripts'),
  saveTranscripts: (sessions) => ipcRenderer.invoke('save-transcripts', sessions),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  clearConfig: () => ipcRenderer.invoke('clear-config'),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('set-launch-at-login', enabled),
  getLaunchAtLogin: () => ipcRenderer.invoke('get-launch-at-login'),
  deviceMetrics: () => ipcRenderer.invoke('device-metrics'),
  onCaptureStopRequested: (callback) => ipcRenderer.on('capture-stop-requested', callback),
  captureStopComplete: () => ipcRenderer.send('capture-stop-complete'),
  onWindowOpened: (callback) => ipcRenderer.on('window-opened', callback),
  onSystemSuspend: (callback) => ipcRenderer.on('system-suspend', callback),
  onSystemResume: (callback) => ipcRenderer.on('system-resume', callback),
});
