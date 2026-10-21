const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, safeStorage, session, Tray } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateSavedApiBase } = require('./device-config');
const transcriptTools = require('./transcript-utils');

let mainWindow;
let tray;
let quitting = false;
let sessionEnding = false;
let pendingWindowAction = null;
let pendingWindowActionTimer = null;
nativeTheme.themeSource = 'light';
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const configPath = () => path.join(app.getPath('userData'), 'device.json');
const transcriptPath = () => path.join(app.getPath('userData'), 'transcripts.enc');

function normalizeApiBase(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error('Enter a valid API address, such as https://api.yourcompany.com.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('The API address must use HTTPS.');
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error('Use HTTPS for remote API connections. Plain HTTP is allowed only for local development.');
  }
  return parsed.origin;
}

function apiUrl(apiBase, route) {
  if (!String(route).startsWith('/api/v1/') && !['/health', '/ready'].includes(String(route))) {
    throw new Error('Desktop API access is limited to Store Listen API routes.');
  }
  return new URL(route, `${normalizeApiBase(apiBase)}/`).toString();
}

function cpuTimes() {
  return os.cpus().reduce((totals, cpu) => ({
    idle: totals.idle + cpu.times.idle,
    total: totals.total + Object.values(cpu.times).reduce((sum, value) => sum + value, 0),
  }), { idle: 0, total: 0 });
}

let previousCpuTimes = cpuTimes();

function completePendingWindowAction() {
  clearTimeout(pendingWindowActionTimer);
  pendingWindowActionTimer = null;
  const action = pendingWindowAction;
  pendingWindowAction = null;
  if (action === 'quit') {
    quitting = true;
    app.quit();
  }
  else if (action === 'hide' && !sessionEnding) mainWindow?.hide();
}

function requestCaptureStop(action) {
  if (pendingWindowAction === 'quit') return;
  if (action === 'quit') pendingWindowAction = 'quit';
  else if (!pendingWindowAction) pendingWindowAction = action;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    completePendingWindowAction();
    return;
  }
  clearTimeout(pendingWindowActionTimer);
  mainWindow.webContents.send('capture-stop-requested');
  pendingWindowActionTimer = setTimeout(completePendingWindowAction, 15_000);
}

ipcMain.on('capture-stop-complete', completePendingWindowAction);

function applicationConfig() {
  if (!app.isPackaged) {
    return {
      isPackaged: false,
      apiBase: normalizeApiBase(process.env.STORE_LISTEN_API_BASE_URL || 'http://localhost:8000'),
    };
  }
  const releaseConfigPath = path.join(process.resourcesPath, 'release-config.json');
  if (!fs.existsSync(releaseConfigPath)) {
    return {
      isPackaged: true,
      apiBase: '',
      error: 'This installer is missing its secure cloud API configuration. Contact your Store Listen administrator.',
    };
  }
  try {
    const releaseConfig = JSON.parse(fs.readFileSync(releaseConfigPath, 'utf8'));
    return { isPackaged: true, apiBase: normalizeApiBase(releaseConfig.apiBase), error: '' };
  } catch {
    return { isPackaged: true, apiBase: '', error: 'The installer cloud API configuration is invalid. Reinstall a correctly configured release.' };
  }
}

async function readResponse(response) {
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) throw new Error(body.detail || `API request failed (${response.status}).`);
  return body;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 760,
    minHeight: 680,
    backgroundColor: '#f4f6f3',
    title: 'Store Listen | Store Capture',
    icon: path.join(__dirname, '..', 'assets', 'store-listen.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('close', (event) => {
    if (!quitting && !sessionEnding) {
      event.preventDefault();
      app.quit();
    }
  });
  mainWindow.on('show', () => mainWindow.webContents.send('window-opened'));
  mainWindow.on('query-session-end', () => {
    sessionEnding = true;
    mainWindow.webContents.send('capture-stop-requested');
  });
  mainWindow.on('session-end', () => {
    sessionEnding = true;
    mainWindow.webContents.send('capture-stop-requested');
  });
  mainWindow.on('focus', () => {
    if (sessionEnding && !pendingWindowAction) sessionEnding = false;
  });
}

function createTray() {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'assets', 'tray.svg'), 'utf8');
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  tray = new Tray(icon);
  tray.setToolTip('Store Listen capture agent');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Store Listen', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Exit', click: () => app.quit() },
  ]));
  tray.on('double-click', () => mainWindow?.show());
}

ipcMain.handle('api-request', async (_event, options) => {
  const headers = { Accept: 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.deviceId) headers['X-Device-ID'] = options.deviceId;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(apiUrl(options.apiBase, options.route), {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(20_000),
  });
  return readResponse(response);
});

ipcMain.handle('audio-upload', async (_event, payload) => {
  const bytes = Buffer.from(payload.audioBytes);
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('Audio recording is empty or larger than the 20 MB limit.');
  const form = new FormData();
  for (const [key, value] of Object.entries(payload.fields)) form.append(key, String(value));
  form.append('audio', new Blob([bytes], { type: payload.contentType }), payload.filename);
  const response = await fetch(apiUrl(payload.apiBase, '/api/v1/audio/recordings'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${payload.deviceSecret}`,
      'X-Device-ID': payload.deviceId,
    },
    body: form,
    signal: AbortSignal.timeout(payload.fields.is_aggregate === 'true' ? 120_000 : 28_000),
  });
  return readResponse(response);
});

ipcMain.handle('audio-preview', async (_event, payload) => {
  const bytes = Buffer.from(payload.audioBytes);
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('Audio preview is empty or larger than the 20 MB limit.');
  const form = new FormData();
  for (const [key, value] of Object.entries(payload.fields)) form.append(key, String(value));
  form.append('audio', new Blob([bytes], { type: payload.contentType }), payload.filename);
  const response = await fetch(apiUrl(payload.apiBase, '/api/v1/audio/transcribe/preview'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${payload.deviceSecret}`,
      'X-Device-ID': payload.deviceId,
    },
    body: form,
    signal: AbortSignal.timeout(12_000),
  });
  return readResponse(response);
});

ipcMain.handle('export-transcript-pdf', async (_event, payload = {}) => {
  const html = transcriptTools.pdfHtml(payload);
  const filename = String(payload.filename || 'store-listen-transcript.pdf').replace(/[\\/:*?"<>|]/g, '-');
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`,
    filters: [{ name: 'PDF document', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { saved: false };
  const tempDirectory = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'store-listen-transcript-'));
  const htmlPath = path.join(tempDirectory, 'transcript.html');
  await fs.promises.writeFile(htmlPath, html, 'utf8');
  const pdfWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  try {
    await pdfWindow.loadFile(htmlPath);
    const pdf = await pdfWindow.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
    await fs.promises.writeFile(filePath, pdf);
    return { saved: true };
  } finally {
    pdfWindow.close();
    await fs.promises.rm(tempDirectory, { recursive: true, force: true });
  }
});

ipcMain.handle('load-transcripts', () => {
  if (!fs.existsSync(transcriptPath())) return [];
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable on this device.');
  const stored = JSON.parse(fs.readFileSync(transcriptPath(), 'utf8'));
  const sessions = JSON.parse(safeStorage.decryptString(Buffer.from(stored.encryptedArchive, 'base64')));
  return Array.isArray(sessions) ? sessions : [];
});

ipcMain.handle('save-transcripts', (_event, sessions) => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable on this device.');
  if (!Array.isArray(sessions) || sessions.length > 500) throw new Error('Transcript archive is invalid or too large.');
  const serialized = JSON.stringify(sessions);
  if (Buffer.byteLength(serialized, 'utf8') > 20 * 1024 * 1024) throw new Error('Transcript archive exceeds the 20 MB local limit.');
  fs.mkdirSync(path.dirname(transcriptPath()), { recursive: true });
  fs.writeFileSync(transcriptPath(), JSON.stringify({
    encryptedArchive: safeStorage.encryptString(serialized).toString('base64'),
  }), { mode: 0o600 });
  return { saved: true };
});

ipcMain.handle('load-config', () => {
  if (!fs.existsSync(configPath())) return null;
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable on this device.');
  let saved = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  const migrated = migrateSavedApiBase(saved, applicationConfig());
  if (migrated !== saved) {
    fs.writeFileSync(configPath(), JSON.stringify(migrated, null, 2), { mode: 0o600 });
    saved = migrated;
  }
  return {
    ...saved,
    deviceSecret: safeStorage.decryptString(Buffer.from(saved.encryptedSecret, 'base64')),
  };
});

ipcMain.handle('save-config', (_event, config) => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable on this device.');
  const saved = {
    apiBase: normalizeApiBase(config.apiBase),
    storeId: String(config.storeId),
    storeName: String(config.storeName),
    deviceId: String(config.deviceId),
    deviceName: String(config.deviceName),
    encryptedSecret: safeStorage.encryptString(String(config.deviceSecret)).toString('base64'),
  };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(saved, null, 2), { mode: 0o600 });
  return { ...saved, deviceSecret: config.deviceSecret };
});

ipcMain.handle('clear-config', () => {
  if (fs.existsSync(configPath())) fs.unlinkSync(configPath());
});

ipcMain.handle('set-launch-at-login', (_event, enabled) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
});

ipcMain.handle('get-launch-at-login', () => app.getLoginItemSettings().openAtLogin);

ipcMain.handle('device-metrics', () => {
  const currentCpuTimes = cpuTimes();
  const elapsedTotal = currentCpuTimes.total - previousCpuTimes.total;
  const elapsedIdle = currentCpuTimes.idle - previousCpuTimes.idle;
  previousCpuTimes = currentCpuTimes;
  const totalMemory = os.totalmem();
  return {
    cpu_pct: elapsedTotal > 0 ? Math.max(0, Math.min(100, Math.round((1 - elapsedIdle / elapsedTotal) * 1000) / 10)) : 0,
    memory_pct: totalMemory > 0 ? Math.max(0, Math.min(100, Math.round(((totalMemory - os.freemem()) / totalMemory) * 1000) / 10)) : 0,
  };
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(permission === 'media' && webContents.getURL().startsWith('file://'));
    });
    createWindow();
    createTray();
    Menu.setApplicationMenu(null);
    app.on('activate', () => mainWindow?.show());
    // Spec: shutdown/sleep must safely stop recording and sync to the server.
    powerMonitor.on('suspend', () => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
      mainWindow.webContents.send('system-suspend');
    });
    powerMonitor.on('resume', () => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
      mainWindow.webContents.send('system-resume');
    });
    powerMonitor.on('shutdown', () => {
      requestCaptureStop('quit');
    });
  });
}

app.on('before-quit', (event) => {
  if (quitting) return;
  if (sessionEnding) {
    quitting = true;
    return;
  }
  event.preventDefault();
  quitting = true;
  requestCaptureStop('quit');
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && quitting) app.quit();
});

ipcMain.handle('app-config', () => applicationConfig());
ipcMain.handle('app-version', () => app.getVersion());
