const $ = (selector) => document.querySelector(selector);
const transcriptTools = window.StoreListenTranscript;
const voiceDetection = window.StoreListenAudioDetection || {};
const deviceHealth = window.StoreListenDeviceHealth;
const { isDeviceSessionExpired } = window.StoreListenDeviceConfig;
const { stopCaptureAndDrain } = window.StoreListenRecordingLifecycle;
const { formatUserError } = window.StoreListenErrorMessages;
const MAX_SEGMENT_MS = voiceDetection.config?.maxSegmentMs ?? 7000;
const MIN_CLIP_MS = voiceDetection.config?.minClipMs ?? 500;
const MIN_VOICED_MS = voiceDetection.config?.minVoicedMs ?? 280;
const PREVIEW_INTERVAL_MS = Math.max(voiceDetection.config?.previewIntervalMs ?? 500, 350);
const LIVE_PREVIEW_ENABLED = voiceDetection.config?.livePreviewEnabled !== false;
// A preview of less than ~0.4s of audio is usually a breath or a click, never a word.
const MIN_PREVIEW_BYTES = 4500;
const RECORDER_TIMESLICE_MS = 100;
const MAX_PARALLEL_UPLOADS = 3;
const STOP_UPLOAD_WAIT_MS = 0;
const PREFERRED_MIC_KEY = 'storelisten.preferredMic';
const MANUAL_STOP_KEY = 'storelisten.manualStop';

// A manual Stop stays stopped across window re-open, PC resume, retries and app restarts.
function isManuallyStopped() {
  try {
    return window.localStorage.getItem(MANUAL_STOP_KEY) === '1';
  } catch {
    return false;
  }
}

function setManuallyStopped(stopped) {
  try {
    if (stopped) window.localStorage.setItem(MANUAL_STOP_KEY, '1');
    else window.localStorage.removeItem(MANUAL_STOP_KEY);
  } catch {
    // Storage is optional; the in-memory capture state still stops capture.
  }
}
const setupScreen = $('#setupScreen');
const appScreen = $('#appScreen');
const state = {
  config: null,
  apiBase: '',
  loginToken: '',
  stores: [],
  capture: null,
  captureStartPromise: null,
  expandedSessionIds: new Set(),
  transcriptCount: 0,
  sessions: [],
  nextFileNumber: 1,
  healthSocket: null,
  healthTimer: null,
  reconnectTimer: null,
  reconnectDelay: 1000,
  healthSpeakingSupported: true,
  apiTimer: null,
  setupHealthTimer: null,
  clockTimer: null,
  reactivationPromise: null,
  captureRetryTimer: null,
  approvalStatus: 'unknown',
  approvalTimer: null,
  waveformFrame: 0,
};

function showError(element, message) {
  if (!element) return;
  const formatted = formatUserError(message);
  // Live capture: never surface Whisper / speech-service / connection noise banners.
  if (element.id === 'captureError' && shouldHideCaptureBanner(formatted)) {
    element.textContent = '';
    element.hidden = true;
    return;
  }
  element.textContent = formatted;
  element.hidden = !formatted;
}

function shouldHideCaptureBanner(message) {
  return /speech service|whisper|private connection|could not process this audio|could not complete that action|temporarily unavailable|timed? ?out|tailscale|backend whisper|no speech was recognized|only english and spanish|finishing uploads|capture is pausing/i.test(String(message || ''));
}

function setHidden(selector, hidden) {
  const element = $(selector);
  if (element) element.hidden = hidden;
}

function setText(selector, text) {
  const element = $(selector);
  if (element) element.textContent = text;
}

function setSetupBusy(button, busy, label) {
  button.disabled = busy;
  button.querySelector('span:first-child').textContent = busy ? label : button.dataset.label;
}

async function checkSetupConnection() {
  const status = $('#setupConnectionStatus');
  if (!state.apiBase || !status) return;
  status.dataset.state = 'checking';
  status.textContent = 'Checking secure backend connection…';
  try {
    const readiness = await request('/ready', { apiBase: state.apiBase, token: '' }, null);
    if (readiness.status !== 'ready') throw new Error('Backend is not ready');
    const isDemo = readiness.mode === 'demo';
    status.dataset.state = isDemo ? 'warning' : 'online';
    status.textContent = isDemo
      ? 'Connected to demo data. Configure DEMO_MODE=false before client use.'
      : 'Backend connected. Sign in with your Store Listen account to activate this PC.';
  } catch {
    status.dataset.state = 'offline';
    status.textContent = 'Backend unreachable. Check Tailscale and confirm the backend computer is online.';
  }
}

async function request(route, options = {}, config = state.config) {
  try {
    return await window.storeListen.request({
      apiBase: options.apiBase || config?.apiBase || state.apiBase,
      route,
      method: options.method || 'GET',
      body: options.body,
      token: options.token || config?.deviceSecret || state.loginToken,
      deviceId: options.deviceId || config?.deviceId,
    });
  } catch (error) {
    await returnToDeviceActivation(error);
    throw error;
  }
}

async function returnToDeviceActivation(error) {
  if (!state.config || !isDeviceSessionExpired(error)) return false;
  if (state.reactivationPromise) {
    await state.reactivationPromise;
    return true;
  }

  const config = state.config;
  state.config = null;
  state.apiBase = config.apiBase;
  state.loginToken = '';
  state.reactivationPromise = (async () => {
    window.clearInterval(state.apiTimer);
    window.clearInterval(state.clockTimer);
    window.clearInterval(state.healthTimer);
    window.clearInterval(state.approvalTimer);
    window.clearTimeout(state.reconnectTimer);
    window.clearInterval(state.setupHealthTimer);
    state.approvalStatus = 'unknown';
    if (state.healthSocket) {
      const socket = state.healthSocket;
      state.healthSocket = null;
      socket.close();
    }

    const capture = state.capture;
    if (capture) {
      capture.requested = false;
      capture.speaking = false;
      window.clearTimeout(capture.segmentTimer);
      if (capture.voiceFrame) window.cancelAnimationFrame(capture.voiceFrame);
      if (capture.recorder && capture.recorder.state !== 'inactive') {
        capture.recorder.ondataavailable = null;
        capture.recorder.onstop = null;
        capture.recorder.onerror = null;
        capture.recorder.stop();
      }
      capture.stream?.getTracks().forEach((track) => track.stop());
      if (capture.audioContext?.state !== 'closed') await capture.audioContext?.close();
      capture.session.status = 'ENDED';
      capture.session.endedAt = new Date();
      state.capture = null;
      await saveTranscriptArchive(true);
    }

    await window.storeListen.clearConfig();
    $('#loginForm').hidden = false;
    $('#deviceForm').hidden = true;
    $('#password').value = '';
    $('#setupTitle').textContent = 'Connect workspace';
    $('#stepCount').textContent = '01 / 02';
    showSetup();
    showError($('#setupError'), 'This device registration is no longer valid. Sign in and activate this PC again. Saved transcripts are kept on this PC.');
  })();

  try {
    await state.reactivationPromise;
  } finally {
    state.reactivationPromise = null;
  }
  return true;
}

function showSetup() {
  setupScreen.hidden = false;
  appScreen.hidden = true;
}

function normalizeTranscriptSessions(sessions) {
  return transcriptTools.normalizeSessions(sessions);
}
function saveTranscriptArchive(immediate = false) {
  clearTimeout(state.archiveSaveTimer);
  return new Promise((resolve) => {
    const persist = () => {
      window.storeListen.saveTranscripts(state.sessions).then((result) => {
        state.archiveError = '';
        resolve(result);
      }).catch((error) => {
        state.archiveError = error.message || 'Could not save encrypted transcripts on this PC.';
        showError($('#transcriptExportFeedback'), `Transcript archive could not be saved: ${state.archiveError}`);
        resolve({ saved: false, error: state.archiveError });
      });
    };
    if (immediate) persist();
    else state.archiveSaveTimer = window.setTimeout(persist, 300);
  });
}

function setActiveView(view) {
  const transcripts = view === 'transcripts';
  state.view = transcripts ? 'transcripts' : 'capture';
  $('#captureView').hidden = transcripts;
  $('#transcriptView').hidden = !transcripts;
  $('#breadcrumbView').textContent = transcripts ? 'Transcripts' : 'Live capture';
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (transcripts) renderTranscriptArchive();
}

function showWorkspace(config) {
  window.clearInterval(state.setupHealthTimer);
  state.setupHealthTimer = null;
  state.config = config;
  setupScreen.hidden = true;
  appScreen.hidden = false;
  $('#sidebarStore').textContent = config.storeName;
  $('#sidebarDevice').textContent = config.deviceName;
  $('#topbarStore').textContent = config.storeName;
  $('#headerDeviceName').textContent = config.deviceName;
  $('#detailStore').textContent = config.storeName;
  $('#deviceIdText').textContent = config.deviceId;
  $('#apiHost').textContent = new URL(config.apiBase).host;
  $('#currentDate').textContent = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date());
  state.transcriptCount = state.sessions.reduce((total, item) => total + item.entries.length, 0);
  $('#transcriptCount').textContent = String(state.transcriptCount);
  $('#feedCount').textContent = 'LIVE · 0';
  $('#navTranscriptCount').textContent = String(state.sessions.length);
  $('#archiveTranscriptCount').textContent = String(state.sessions.length);
  setActiveView('capture');
  renderTranscriptArchive();
  void ensureDefaultMicrophoneSelected();
  const micSelect = $('#microphoneSelect');
  if (micSelect && !micSelect.dataset.boundPreferred) {
    micSelect.dataset.boundPreferred = '1';
    micSelect.addEventListener('change', () => rememberPreferredMic(micSelect.value));
  }
  void checkApi();
  connectHealth();
  state.apiTimer = window.setInterval(checkApi, 20_000);
  state.clockTimer = window.setInterval(updateSessionClock, 1000);
  void beginApprovedCapture();
}

function setDeviceStatus(online) {
  const badge = $('#deviceStatus');
  badge.classList.toggle('offline', !online);
  badge.querySelector('span').textContent = online ? 'Connected' : 'Reconnecting';
}

let apiFailureStreak = 0;
let apiRecheckTimer = null;

function setApiStatus(online) {
  // One slow request must not flip the badge; show Unavailable only after two failures in a row.
  apiFailureStreak = online ? 0 : apiFailureStreak + 1;
  if (!online && apiFailureStreak < 2) return;
  const status = $('#apiStatus');
  const html = `<i class="status-dot${online ? '' : ' bad'}"></i>${online ? 'Available' : 'Unavailable'}`;
  if (status.innerHTML !== html) status.innerHTML = html;
  if (!online && !state.capture) $('#deliveryStat').innerHTML = '<i class="stat-dot pending"></i>Offline';
  else if (online && !state.capture) $('#deliveryStat').innerHTML = '<i class="stat-dot"></i>Ready';
}

async function checkApi() {
  try {
    await request('/health');
    setApiStatus(true);
  } catch {
    setApiStatus(false);
    // Render may be waking up or redeploying: look again in 4s instead of waiting a full cycle.
    window.clearTimeout(apiRecheckTimer);
    apiRecheckTimer = window.setTimeout(() => void checkApi(), 4_000);
  }
}

function setMicrophoneStatus(label, type = 'neutral') {
  const status = $('#micStatus');
  status.innerHTML = `<i class="status-dot${type === 'ok' ? '' : type === 'bad' ? ' bad' : ' neutral'}"></i>${label}`;
}

function preferredMicId() {
  try {
    return window.localStorage.getItem(PREFERRED_MIC_KEY) || '';
  } catch {
    return '';
  }
}

function rememberPreferredMic(deviceId) {
  try {
    if (deviceId) window.localStorage.setItem(PREFERRED_MIC_KEY, deviceId);
  } catch {
    // ignore storage failures
  }
}

function audioCaptureConstraints(deviceId = '') {
  const base = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  };
  if (deviceId) return { ...base, deviceId: { ideal: deviceId } };
  return base;
}

async function refreshMicrophones(forceDeviceId = '') {
  const select = $('#microphoneSelect');
  const previous = forceDeviceId || select.value || preferredMicId();
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const microphones = devices.filter((device) => device.kind === 'audioinput');
    select.replaceChildren();
    // Put the OS default first so Start uses the same mic Windows routes by default.
    select.add(new Option('Default system microphone', ''));
    microphones.forEach((device, index) => {
      const label = device.label || `Microphone ${index + 1}`;
      select.add(new Option(label, device.deviceId));
    });
    if (previous && microphones.some((device) => device.deviceId === previous)) {
      select.value = previous;
    } else {
      select.value = '';
    }
  } catch {
    select.replaceChildren(new Option('Default system microphone', ''));
  }
}

async function ensureDefaultMicrophoneSelected() {
  const select = $('#microphoneSelect');
  try {
    // Unlock device labels + bind to the real default Windows input before Start.
    const probe = await navigator.mediaDevices.getUserMedia({
      audio: audioCaptureConstraints(preferredMicId()),
      video: false,
    });
    const activeId = probe.getAudioTracks()[0]?.getSettings?.()?.deviceId || '';
    probe.getTracks().forEach((track) => track.stop());
    await refreshMicrophones(activeId || preferredMicId());
    if (activeId) {
      select.value = activeId;
      rememberPreferredMic(activeId);
    } else {
      select.value = preferredMicId() || '';
    }
    const chosen = select.selectedOptions?.[0]?.textContent || 'Default system microphone';
    setMicrophoneStatus(`${chosen} ready`, 'ok');
  } catch {
    await refreshMicrophones(preferredMicId());
    select.value = preferredMicId() || '';
  }
}

function updateSessionClock() {
  const capture = state.capture;
  if (!capture?.startedAt) return;
  const seconds = Math.floor((Date.now() - capture.startedAt) / 1000);
  const hours = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const remainder = String(seconds % 60).padStart(2, '0');
  $('#sessionTime').textContent = `${hours}:${minutes}:${remainder}`;
  $('#sessionStat').textContent = `${minutes}:${remainder}`;
}

function sendHealth(overrides = {}) {
  const socket = state.healthSocket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  void window.storeListen.deviceMetrics().then((metrics) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const recording = Boolean(state.capture?.requested);
    const speaking = Boolean(overrides.speaking ?? state.capture?.speaking);
    socket.send(JSON.stringify(deviceHealth.createPayload(metrics, recording, speaking, state.healthSpeakingSupported)));
  }).catch(() => {});
}

function scheduleHealthReconnect() {
  if (!state.config) return;
  window.clearTimeout(state.reconnectTimer);
  const delay = state.reconnectDelay;
  state.reconnectDelay = Math.min(delay * 1.6, 6_000);
  state.reconnectTimer = window.setTimeout(connectHealth, Math.round(delay * (0.75 + Math.random() * 0.5)));
}

function connectHealth() {
  if (!state.config || state.healthSocket) return;
  const base = new URL(state.config.apiBase);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = `/ws/device/${encodeURIComponent(state.config.deviceId)}`;
  try {
    const socket = new WebSocket(base.toString(), ['storelisten.v1', state.config.deviceSecret]);
    state.healthSocket = socket;
    socket.onopen = () => {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectDelay = 1000;
      setDeviceStatus(true);
      sendHealth();
      state.healthTimer = window.setInterval(sendHealth, 10_000);
    };
    socket.onclose = (event) => {
      if (event.code === 4401) {
        void returnToDeviceActivation(new Error('Invalid or expired session'));
        return;
      }
      if (event.code === 1008) state.healthSpeakingSupported = false;
      if (state.healthSocket === socket) state.healthSocket = null;
      window.clearInterval(state.healthTimer);
      setDeviceStatus(false);
      scheduleHealthReconnect();
    };
    socket.onerror = () => socket.close();
  } catch {
    state.healthSocket = null;
    setDeviceStatus(false);
    scheduleHealthReconnect();
  }
}

function setApprovalBanner(status) {
  const banner = $('#approvalBanner');
  if (!banner) return;
  if (status === 'approved') {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  if (status === 'rejected') {
    banner.textContent = 'This device was rejected by an admin. Re-register after they clear the request.';
  } else {
    banner.textContent = 'Waiting for admin approval before this device can start listening.';
  }
}

async function refreshApprovalStatus() {
  if (!state.config?.deviceId) return state.approvalStatus;
  try {
    const result = await request(`/api/v1/devices/${encodeURIComponent(state.config.deviceId)}/approval`);
    state.approvalStatus = result.approved ? 'approved' : (result.approval_status || 'pending');
  } catch {
    // Keep last known status when the approval check fails briefly.
  }
  setApprovalBanner(state.approvalStatus);
  const blocked = state.approvalStatus !== 'approved';
  if (blocked && !state.capture) {
    $('#captureButton').disabled = true;
    $('#captureTitle').textContent = state.approvalStatus === 'rejected' ? 'Approval rejected' : 'Awaiting approval';
    $('#captureMessage').textContent = state.approvalStatus === 'rejected'
      ? 'Ask an admin to approve this store device, then restart capture.'
      : 'Recording stays off until an admin approves this store in the web portal.';
  }
  return state.approvalStatus;
}

function startApprovalPolling() {
  window.clearInterval(state.approvalTimer);
  const tick = () => {
    void (async () => {
      const previous = state.approvalStatus;
      const status = await refreshApprovalStatus();
      if (previous !== 'approved' && status === 'approved' && state.config && !state.capture) {
        void startCapture();
      }
    })();
  };
  // Fast poll while waiting so recording starts as soon as admin approves.
  state.approvalTimer = window.setInterval(tick, 3_000);
}

async function beginApprovedCapture() {
  const status = await refreshApprovalStatus();
  startApprovalPolling();
  if (status === 'approved') void startCapture();
}

let smoothedMicLevel = 0;

function updateMicWaveform(samples, speaking) {
  const bars = $('#micWaveform')?.querySelectorAll('i');
  if (!bars?.length) return;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 8) sum += samples[index] * samples[index];
  const rms = Math.sqrt(sum / Math.max(1, Math.floor(samples.length / 8)));
  const raw = Math.min(1, rms * 12);
  // Fast rise, slow fall, so the bars glide instead of flickering every frame.
  smoothedMicLevel = Math.max(raw, smoothedMicLevel * 0.9);
  const level = speaking ? Math.max(smoothedMicLevel, 0.15) : smoothedMicLevel;
  bars.forEach((bar, index) => {
    const weight = 0.35 + ((index % 4) * 0.18);
    const height = 4 + Math.round(level * weight * 18);
    if (bar.dataset.h !== String(height)) {
      bar.dataset.h = String(height);
      bar.style.height = `${height}px`;
    }
  });
}

function resetMicWaveform() {
  const bars = $('#micWaveform')?.querySelectorAll('i');
  bars?.forEach((bar) => { bar.style.height = '4px'; });
}

function setCaptureUi(recording, busy = false, ended = false) {
  const hero = $('#captureHero');
  if (hero) hero.classList.toggle('recording', recording);
  const indicator = $('#captureIndicator span');
  if (indicator) indicator.textContent = recording ? 'LIVE' : busy ? 'SAVING' : ended ? 'ENDED' : 'READY';
  const awaitingApproval = state.approvalStatus !== 'approved' && state.approvalStatus !== 'unknown';
  $('#captureTitle').textContent = awaitingApproval && !recording
    ? (state.approvalStatus === 'rejected' ? 'Approval rejected' : 'Awaiting approval')
    : recording ? 'Listening' : busy ? 'Saving…' : ended ? 'Session saved' : 'Ready to capture';
  $('#captureMessage').textContent = awaitingApproval && !recording
    ? 'Recording stays off until an admin approves this store in the web portal.'
    : recording
      ? 'Microphone is active. Conversation text appears in English.'
      : busy ? 'Finishing uploads…' : ended ? 'Start again for the next conversation.' : 'Pick a mic and start.';
  $('#captureButtonLabel').textContent = recording ? 'Stop' : busy ? 'Saving…' : 'Start';
  $('#captureButton').classList.toggle('stopping', recording);
  $('#captureButton').disabled = busy || (awaitingApproval && !recording);
  $('#microphoneSelect').disabled = recording || busy;
  $('#deliveryStat').innerHTML = recording ? '<i class="stat-dot"></i>Live' : ended ? '<i class="stat-dot"></i>Ended' : '<i class="stat-dot"></i>Ready';
  if (recording) $('#captureButtonIcon').innerHTML = '<rect x="6" y="6" width="12" height="12" rx="1"/>';
  else $('#captureButtonIcon').innerHTML = '<path d="M12 3v12M8 7v7a4 4 0 0 0 8 0V7M5 12a7 7 0 0 0 14 0M12 19v3M9 22h6"/>';
  if (!recording) resetMicWaveform();
}

function createParagraphBlock(paragraph, index) {
  const item = document.createElement('article');
  item.className = 'transcript-paragraph';
  const meta = document.createElement('header');
  meta.className = 'transcript-paragraph-meta';
  const label = document.createElement('span');
  label.className = 'transcript-paragraph-label';
  label.textContent = `Paragraph ${String(index + 1).padStart(2, '0')}`;
  const time = document.createElement('time');
  time.className = 'transcript-time';
  time.textContent = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', second: '2-digit',
  }).format(new Date(paragraph.startedAt));
  meta.append(label, time);

  // Spoken language on top; English translation under Spanish (never Spanish under Spanish).
  const parts = transcriptTools.paragraphParts(paragraph.entries);
  const spokenPlain = parts.map((part) => part.original).join(' ').trim();
  const englishText = parts.map((part) => (
    part.kind === 'es' ? (part.translation || '') : part.original
  )).filter(Boolean).join(' ').trim();
  const body = document.createElement('p');
  body.className = 'transcript-paragraph-body';
  body.textContent = spokenPlain || 'No speech detected.';
  item.append(meta, body);

  if (parts.some((part) => part.kind === 'es')) {
    const en = document.createElement('p');
    en.className = 'transcript-paragraph-en';
    const tag = document.createElement('span');
    tag.className = 'transcript-en-tag';
    tag.textContent = 'EN';
    en.append(tag, document.createTextNode(` ${englishText || 'Translation unavailable'}`));
    item.append(en);
  }
  return item;
}

function ensureConversationHost() {
  const list = $('#transcriptList');
  const empty = $('#emptyTranscript');
  if (empty) empty.remove();
  let linesHost = $('#liveTranscriptLines');
  if (!linesHost) {
    linesHost = document.createElement('div');
    linesHost.className = 'live-transcript-lines';
    linesHost.id = 'liveTranscriptLines';
    list.replaceChildren(linesHost);
  }
  $('#livePartialRow')?.remove();
  return linesHost;
}

function getOrCreateLiveBody() {
  const host = ensureConversationHost();
  let body = host.querySelector('.transcript-paragraph:last-of-type .transcript-paragraph-body');
  if (body) return body;
  const item = document.createElement('article');
  item.className = 'transcript-paragraph';
  item.innerHTML = `<header class="transcript-paragraph-meta"><span class="transcript-paragraph-label">Paragraph 01</span><time class="transcript-time">${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date())}</time></header><p class="transcript-paragraph-body"></p>`;
  host.append(item);
  return item.querySelector('.transcript-paragraph-body');
}

function getOrCreateLiveTrail(body) {
  let trail = $('#liveTypingTrail');
  if (!trail) {
    trail = document.createElement('span');
    trail.id = 'liveTypingTrail';
    trail.className = 'live-typing-trail';
    if ([...body.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) {
      body.append(document.createTextNode(' '));
    }
    body.append(trail);
  } else if (trail.parentElement !== body) {
    if (body.textContent?.trim()) body.append(document.createTextNode(' '));
    body.append(trail);
  }
  return trail;
}

function paintLiveTrail(text) {
  const capture = state.capture;
  if (!capture?.requested) return;
  const body = getOrCreateLiveBody();
  const trail = getOrCreateLiveTrail(body);
  const spoken = String(text || '').trim();
  trail.textContent = spoken;
  const list = $('#transcriptList');
  if (list) list.scrollTop = list.scrollHeight;
}

function clearLivePartial() {
  $('#liveTypingTrail')?.remove();
  if (state.capture) {
    state.capture.latestPreviewText = '';
    state.capture.livePartialEnglish = '';
  }
}

function showLivePartial(segment) {
  const original = String(segment?.originalText || '').trim();
  if (!original || isClientJunkLive(original)) return;
  const translated = String(segment?.translatedText || '').trim();
  const language = String(segment?.language || 'en').toLowerCase();
  const spanish = language === 'es' || transcriptTools.looksLikeSpanishText?.(original)
    || /[¿¡ñáéíóúü]|señor|tenemos|producto|gracias|hola|dólares|dolares/i.test(original);
  const english = spanish
    && translated
    && translated !== original
    && !(transcriptTools.looksLikeSpanishText?.(translated) || /señor|tenemos|producto|gracias|hola|dólares|dolares/i.test(translated))
    ? translated
    : '';
  if (state.capture) {
    state.capture.latestPreviewText = original;
    state.capture.livePartialEnglish = english;
  }
  paintLiveTrail(original);
  const body = getOrCreateLiveBody();
  const paragraph = body.closest('.transcript-paragraph');
  if (spanish && paragraph) {
    let en = paragraph.querySelector('.transcript-paragraph-en');
    if (!en) {
      en = document.createElement('p');
      en.className = 'transcript-paragraph-en';
      en.innerHTML = '<span class="transcript-en-tag">EN</span> <span class="live-en-text"></span>';
      paragraph.append(en);
    }
    const enText = en.querySelector('.live-en-text');
    if (enText) enText.textContent = english || 'Translating…';
  }
}

function captureDuration(session) {
  return transcriptTools.duration(session);
}

function transcriptFileText(session) {
  return transcriptTools.transcriptText(state.config.storeName, state.config.deviceName, session);
}

function transcriptFilename(session, extension) {
  return transcriptTools.filename(state.config.storeName, session, extension);
}

async function downloadTranscript(session, format) {
  const filename = transcriptFilename(session, format);
  if (format === 'pdf') {
    const result = await window.storeListen.exportTranscriptPdf({
      filename,
      storeName: state.config.storeName,
      deviceName: state.config.deviceName,
      startedAt: session.startedAt.toLocaleString(),
      duration: captureDuration(session),
      status: session.status,
      entries: session.entries.slice().sort((left, right) => left.number - right.number).map((entry) => ({
        number: entry.number,
        capturedAt: entry.capturedAt,
        time: entry.capturedAt.toLocaleTimeString(),
        speaker: normalizeSpeakerLabel(entry.segment.speakerLabel),
        language: entry.segment.language || 'und',
        originalText: entry.segment.originalText || 'No speech recognized.',
        translatedText: entry.segment.translatedText || '',
        segment: entry.segment,
      })),
    });
    return Boolean(result?.saved);
  }
  const blob = new Blob([transcriptFileText(session)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

function renderTranscriptArchive() {
  const query = $('#transcriptSearch').value.trim().toLowerCase();
  const list = $('#transcriptArchiveList');
  const fragment = document.createDocumentFragment();
  const matchingSessions = state.sessions.map((session) => ({
    session,
    entries: session.entries.filter(({ segment }) =>
      `${segment.originalText || ''} ${segment.translatedText || ''} ${segment.language || ''}`.toLowerCase().includes(query)),
  })).filter(({ session, entries }) => !query || entries.length || !session.entries.length);

  $('#archiveTranscriptCount').textContent = String(state.sessions.length);
  $('#navTranscriptCount').textContent = String(state.sessions.length);
  if (!matchingSessions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-transcript';
    const heading = document.createElement('strong');
    heading.textContent = query ? 'No matching capture sessions' : 'No capture sessions yet';
    const detail = document.createElement('span');
    detail.textContent = query ? 'Try another word or language.' : 'Start and stop capture to create a transcript file.';
    empty.append(heading, detail);
    fragment.append(empty);
  } else {
    matchingSessions.forEach(({ session, entries }) => {
      const card = document.createElement('article');
      card.className = 'transcript-session-card';
      const heading = document.createElement('header');
      heading.className = 'transcript-session-heading';
      const identity = document.createElement('div');
      identity.className = 'transcript-session-identity';
      const number = document.createElement('span');
      number.className = 'session-file-number';
      number.textContent = String(session.fileNumber).padStart(3, '0');
      const details = document.createElement('div');
      const title = document.createElement('h2');
      title.textContent = `Capture ${String(session.fileNumber).padStart(3, '0')}`;
      const subtitle = document.createElement('p');
          subtitle.textContent = `${session.startedAt.toLocaleString()} · ${transcriptTools.groupEntriesIntoParagraphs(session.entries).length} paragraphs · ${captureDuration(session)}`;
      details.append(title, subtitle);
      const status = document.createElement('span');
      status.className = `session-status${session.status === 'LIVE' ? ' live' : ''}`;
      status.textContent = session.status === 'LIVE' ? 'LIVE' : 'COMPLETE';
      const toggle = document.createElement('button');
      toggle.className = 'transcript-session-toggle';
      toggle.type = 'button';
      toggle.dataset.sessionToggle = session.id;
      toggle.setAttribute('aria-controls', `archive-lines-${session.fileNumber}`);
      const expanded = state.expandedSessionIds.has(session.id);
      toggle.setAttribute('aria-expanded', String(expanded));
      const chevron = document.createElement('span');
      chevron.className = 'session-toggle-icon';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '⌄';
      identity.append(number, details, status, chevron);
      toggle.append(identity);
      const downloads = document.createElement('div');
      downloads.className = 'session-downloads';
      for (const format of ['txt', 'pdf']) {
        const button = document.createElement('button');
        button.className = 'download-button';
        button.type = 'button';
        button.dataset.sessionId = session.id;
        button.dataset.format = format;
        button.textContent = format.toUpperCase();
        button.title = `Download capture ${session.fileNumber} as ${format.toUpperCase()}`;
        downloads.append(button);
      }
      heading.append(toggle, downloads);
      card.append(heading);
      const transcript = document.createElement('div');
      transcript.className = 'session-transcript-lines';
      transcript.id = `archive-lines-${session.fileNumber}`;
      transcript.hidden = !expanded;
      if (entries.length) {
        transcriptTools.groupEntriesIntoParagraphs(entries).forEach((paragraph, index) => {
          const row = document.createElement('div');
          row.className = 'session-transcript-row';
          row.append(createParagraphBlock(paragraph, index));
          transcript.append(row);
        });
      } else if (expanded) {
        const empty = document.createElement('p');
        empty.className = 'session-empty-lines';
        empty.textContent = session.entries.length ? 'No paragraphs match this search.' : 'No speech recognized in this capture.';
        transcript.append(empty);
      }
      card.append(transcript);
      fragment.append(card);
    });
  }
  list.replaceChildren(fragment);
}

function renderLiveTranscript(session) {
  const list = $('#transcriptList');
  const empty = $('#emptyTranscript');
  if (empty) empty.remove();
  let linesHost = $('#liveTranscriptLines');
  if (!linesHost) {
    linesHost = document.createElement('div');
    linesHost.className = 'live-transcript-lines';
    linesHost.id = 'liveTranscriptLines';
    list.replaceChildren(linesHost);
  }
  const fragment = document.createDocumentFragment();
  transcriptTools.groupEntriesIntoParagraphs(session.entries).forEach((paragraph, index) => {
    fragment.append(createParagraphBlock(paragraph, index));
  });
  linesHost.replaceChildren(fragment);
  list.scrollTop = list.scrollHeight;
}

function normalizeSpeakerLabel(label) {
  if (!label || label === 'Speaker not identified' || label === 'Unattributed speaker') return 'Speaker';
  return label;
}

const CLIENT_JUNK_EXACT = new Set([
  'tchau', 'chao', 'obrigado', 'obrigada', 'adeus', 'valeu', 'ciao',
  'e ai', 'ai', 'ei', 'oie', 'opa',
  'hmm', 'uh', 'um',
  'terima kasih', 'terima kasih telah menonton',
]);

function normalizeClientPhrase(text) {
  return (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isClientJunkLive(text) {
  const phrase = normalizeClientPhrase(text);
  if (!phrase) return true;
  if (CLIENT_JUNK_EXACT.has(phrase)) return true;
  return phrase.includes('terima kasih') || phrase.includes('menonton') || phrase.includes('thanks for watching');
}

function isClientJunkTranscript(text) {
  // Keep finals permissive so short Spanish/English store words are not dropped.
  return isClientJunkLive(text);
}

function addTranscript(segment) {
  const session = state.capture?.session;
  if (!session) return;
  const text = (segment.originalText || '').trim();
  if (!text || isClientJunkTranscript(text)) return;
  const offset = Number(segment.sessionOffsetSeconds);
  const capturedAt = Number.isFinite(offset)
    ? new Date(session.startedAt.getTime() + Math.max(0, offset) * 1000)
    : new Date();
  if (session.entries.some((entry) => (
    entry.segment.originalText?.trim().toLowerCase() === text.toLowerCase()
    && Math.abs(entry.capturedAt.getTime() - capturedAt.getTime()) < 4_000
  ))) return;
  const entry = {
    number: session.entries.length + 1,
    segment: { ...segment, speakerLabel: normalizeSpeakerLabel(segment.speakerLabel) },
    capturedAt,
  };
  session.entries.push(entry);
  session.entries.sort((left, right) => left.capturedAt - right.capturedAt);
  session.entries.forEach((item, index) => { item.number = index + 1; });
  const pendingLive = state.capture?.latestPreviewText || '';
  clearLivePartial();
  saveTranscriptArchive();
  renderLiveTranscript(session);
  if (state.capture?.requested
    && pendingLive
    && !String(segment.originalText || '').toLowerCase().includes(pendingLive.toLowerCase().slice(0, 12))) {
    paintLiveTrail(pendingLive);
  }
  state.transcriptCount += 1;
  $('#transcriptCount').textContent = String(state.transcriptCount);
  $('#navTranscriptCount').textContent = String(state.sessions.length);
  $('#archiveTranscriptCount').textContent = String(state.sessions.length);
  $('#feedCount').textContent = `LIVE · ${state.transcriptCount}`;
  const timestamp = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date());
  const lang = (segment.language || '').toUpperCase();
  $('#lastTranscript').textContent = Number.isFinite(segment.transcriptionMs)
    ? `${timestamp} · ${lang || 'STT'} ${(segment.transcriptionMs / 1000).toFixed(1)}s`
    : timestamp;
  $('#deliveryStat').innerHTML = '<i class="stat-dot"></i>Live';
  if (state.view === 'transcripts') renderTranscriptArchive();
}

function refreshUploadDrain(capture) {
  capture.uploadQueue = Promise.allSettled([...capture.inflightUploads]).then(() => undefined);
  if (!capture.inflightUploads.size) {
    $('#deliveryStat').innerHTML = '<i class="stat-dot"></i>Live';
  } else {
    $('#deliveryStat').innerHTML = `<i class="stat-dot pending"></i>Transcribing ${capture.activeUploads || capture.inflightUploads.size}`;
  }
}

async function waitForUploadSlot(capture) {
  while ((capture.activeUploads || 0) >= MAX_PARALLEL_UPLOADS) {
    if (!capture.inflightUploads.size) break;
    await Promise.race([...capture.inflightUploads]);
  }
}

async function uploadSegment(capture, blob, sequence, offset, duration) {
  if (!blob.size) return;
  const uploadStartedAt = performance.now();
  const response = await window.storeListen.uploadAudio({
    apiBase: state.config.apiBase,
    deviceId: state.config.deviceId,
    deviceSecret: state.config.deviceSecret,
    contentType: blob.type.split(';')[0] || 'audio/webm',
    filename: `store-capture-${sequence}.webm`,
    audioBytes: new Uint8Array(await blob.arrayBuffer()),
    fields: {
      store_id: state.config.storeId,
      conversation_id: capture.conversationId,
      speaker_role: 'unknown',
      capture_sequence: sequence,
      duration_seconds: Math.max(0.1, duration),
      session_offset_seconds: Math.max(0, offset),
    },
  });
  setHidden('#liveTranscriptPreview', true);
  setText('#liveTranscriptPreviewText', '');
  if (response.segment) addTranscript({
    ...response.segment,
    sessionOffsetSeconds: offset,
    transcriptionMs: response.transcription_ms,
    roundTripMs: Math.round(performance.now() - uploadStartedAt),
    speechProvider: response.speech_provider,
  });
  else if (!capture.recorder && !capture.speaking) {
    // The server heard no real speech in this clip: remove the provisional words instead of leaving them.
    clearLivePartial();
  }
  if (response.segment) showError($('#captureError'), '');
  setApiStatus(true);
}

function enqueueUpload(capture, blob, sequence, offset, duration) {
  const job = (async () => {
    await waitForUploadSlot(capture);
    capture.activeUploads = (capture.activeUploads || 0) + 1;
    refreshUploadDrain(capture);
    try {
      // A short API hiccup (cold start, redeploy) must not swallow what the customer said.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await uploadSegment(capture, blob, sequence, offset, duration);
          break;
        } catch (error) {
          if (attempt >= 3 || isDeviceSessionExpired(error)) throw error;
          await new Promise((resolve) => window.setTimeout(resolve, 1200 * (attempt + 1)));
        }
      }
    } finally {
      capture.activeUploads = Math.max(0, (capture.activeUploads || 1) - 1);
    }
  })().catch(async (error) => {
    if (await returnToDeviceActivation(error)) return;
    // Never auto-stop on a failed clip — stay LIVE until manual Stop or PC sleep/shutdown.
    setApiStatus(false);
    if (capture.requested) {
      setMicrophoneStatus('Microphone is active', 'ok');
      setCaptureUi(true);
    }
  });
  capture.inflightUploads.add(job);
  refreshUploadDrain(capture);
  void job.finally(() => {
    capture.inflightUploads.delete(job);
    refreshUploadDrain(capture);
  });
}

function beginRecorder(capture) {
  if (!capture.requested || !capture.stream?.active || capture.recorder) return;
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) {
    showError($('#captureError'), 'This Windows device cannot record WebM/Opus audio. Update Store Listen or use a supported microphone driver.');
    capture.requested = false;
    void stopCapture();
    return;
  }
  const recorder = new MediaRecorder(capture.stream, { mimeType, audioBitsPerSecond: 96_000 });
  const chunks = [];
  const startedAt = Date.now();
  const previewThrottle = LIVE_PREVIEW_ENABLED && voiceDetection.createPreviewThrottle
    ? voiceDetection.createPreviewThrottle(PREVIEW_INTERVAL_MS)
    : null;
  capture.previewThrottle = previewThrottle;
  capture.previewSequence = capture.previewSequence || 0;
  capture.spokeInSegment = Boolean(capture.speaking);
  capture.segmentPeakRms = 0;
  capture.segmentVoicedMs = 0;
  capture.discardSegment = false;
  capture.recorder = recorder;
  capture.segmentStartedAt = startedAt;
  // Preview state belongs to this one phrase, so a late answer can never paint into the next one.
  let previewBusy = false;
  let previewApplied = 0;
  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    chunks.push(event.data);
    if (!LIVE_PREVIEW_ENABLED || !capture.requested || !capture.previewThrottle || previewBusy) return;
    // Words stream only while real speech is happening, never for room noise.
    if (capture.recorder !== recorder || !capture.speaking) return;
    const previewBlob = new Blob(chunks, { type: mimeType });
    if (previewBlob.size < MIN_PREVIEW_BYTES) return;
    if (!capture.previewThrottle.shouldSend(Date.now())) return;
    const previewSequence = ++capture.previewSequence;
    previewBusy = true;
    void (async () => {
      try {
        const response = await window.storeListen.previewAudio({
          apiBase: state.config.apiBase,
          deviceId: state.config.deviceId,
          deviceSecret: state.config.deviceSecret,
          contentType: mimeType.split(';')[0] || 'audio/webm',
          filename: `store-preview-${capture.sequence + 1}.webm`,
          audioBytes: new Uint8Array(await previewBlob.arrayBuffer()),
          fields: {
            store_id: state.config.storeId,
            conversation_id: capture.conversationId,
            capture_sequence: capture.sequence + 1,
            preview_sequence: previewSequence,
          },
        });
        // The phrase already ended (final is on its way) or a newer answer was shown: drop this one.
        if (capture.recorder !== recorder || !capture.requested || previewSequence < previewApplied) return;
        if (response?.segment?.originalText) {
          previewApplied = previewSequence;
          showLivePartial(response.segment);
        }
      } catch {
        // Final transcription remains authoritative if a provisional preview fails.
      } finally {
        previewBusy = false;
      }
    })();
  };
  recorder.onerror = () => {
    // Keep session LIVE; a single recorder fault must not end the day.
    if (capture.requested) {
      capture.recorder = null;
      setMicrophoneStatus(capture.speaking ? 'Voice detected' : 'Microphone is active', 'ok');
      if (capture.speaking) beginRecorder(capture);
    }
  };
  recorder.onstop = () => {
    if (capture.recorder === recorder) capture.recorder = null;
    clearTimeout(capture.segmentTimer);
    const blob = new Blob(chunks, { type: mimeType });
    const durationMs = Date.now() - startedAt;
    const duration = Math.max(durationMs / 1000, 0.1);
    const offset = Math.max((startedAt - capture.startedAt) / 1000, 0);
    capture.offset = offset + duration;
    // Only a clip with real, sustained speech is sent. Clicks, coughs and fan noise never reach Whisper.
    const discarded = capture.discardSegment;
    const hadVoice = !discarded && capture.segmentVoicedMs >= MIN_VOICED_MS;
    capture.discardSegment = false;
    if (hadVoice && blob.size && durationMs >= MIN_CLIP_MS) {
      const sequence = ++capture.sequence;
      enqueueUpload(capture, blob, sequence, offset, duration);
    } else if (!capture.speaking) {
      // Nothing worth transcribing: remove any half-painted live words.
      clearLivePartial();
    }
    // A phrase that hit the time limit continues straight into the next clip.
    if (capture.requested && capture.speaking) {
      beginRecorder(capture);
    }
  };
  recorder.start(RECORDER_TIMESLICE_MS);
  capture.segmentTimer = window.setTimeout(() => {
    if (recorder.state === 'recording') recorder.stop();
  }, MAX_SEGMENT_MS);
}

function monitorVoice(capture) {
  const samples = new Float32Array(capture.analyser.fftSize);
  const spectrum = new Float32Array(capture.analyser.frequencyBinCount);
  const gate = voiceDetection.createVoiceGate ? voiceDetection.createVoiceGate() : null;
  let lastTickAt = performance.now();
  const tick = () => {
    if (!capture.requested) return;
    const now = performance.now();
    const elapsed = Math.min(now - lastTickAt, 100);
    lastTickAt = now;
    capture.analyser.getFloatTimeDomainData(samples);
    capture.analyser.getFloatFrequencyData(spectrum);
    const energy = voiceDetection.calculateAudioEnergy?.(samples) || { rms: 0, peak: 0 };
    capture.segmentPeakRms = Math.max(capture.segmentPeakRms || 0, energy.rms || 0);
    updateMicWaveform(samples, capture.speaking);
    const result = gate
      ? gate.observe(samples, spectrum, capture.audioContext.sampleRate, now)
      : { state: 'idle' };
    if (result.state === 'rising' && !capture.recorder) {
      // Record from the first voiced frame so the start of the first word is not cut off.
      beginRecorder(capture);
    } else if (result.state === 'start') {
      if (!capture.speaking) {
        capture.speaking = true;
        setMicrophoneStatus('Voice detected', 'ok');
        sendHealth({ speaking: true });
      }
      if (!capture.recorder) beginRecorder(capture);
    } else if (result.state === 'idle' && capture.recorder?.state === 'recording' && !capture.speaking) {
      // The first voiced frame was a click, not speech: throw that clip away.
      // A recorder already told to stop is "inactive", so a finished phrase is never discarded here.
      capture.discardSegment = true;
      capture.recorder.stop();
    } else if (result.state === 'end') {
      capture.speaking = false;
      setMicrophoneStatus('Microphone is active', 'ok');
      sendHealth({ speaking: false });
      if (capture.recorder?.state === 'recording') capture.recorder.stop();
    }
    if (capture.speaking && (result.state === 'start' || result.state === 'speech')) {
      capture.spokeInSegment = true;
      capture.segmentVoicedMs = (capture.segmentVoicedMs || 0) + elapsed;
    }
    capture.voiceFrame = window.requestAnimationFrame(tick);
  };
  capture.voiceFrame = window.requestAnimationFrame(tick);
}

async function stopCapture({ reason = 'manual' } = {}) {
  if (state.captureStartPromise) await state.captureStartPromise;
  const capture = state.capture;
  if (!capture) return;
  if (capture.stopPromise) return capture.stopPromise;
  // Session save only for manual Stop or PC sleep/shutdown — never for silence/upload errors.
  if (!['manual', 'sleep', 'shutdown', 'quit'].includes(reason)) return;
  // Only the person pressing Stop makes the stop permanent; sleep/quit still auto-resume.
  if (reason === 'manual') {
    setManuallyStopped(true);
    window.clearTimeout(state.captureRetryTimer);
  }
  capture.requested = false;
  capture.speaking = false;
  clearLivePartial();
  setCaptureUi(false, true);
  clearTimeout(capture.segmentTimer);
  if (capture.voiceFrame) window.cancelAnimationFrame(capture.voiceFrame);
  capture.stopPromise = (async () => {
    // Release mic instantly; do not wait on remote STT uploads.
    await stopCaptureAndDrain(
      capture,
      () => setMicrophoneStatus('Not active', 'neutral'),
      { maxUploadWaitMs: STOP_UPLOAD_WAIT_MS },
    );
    capture.session.status = 'ENDED';
    capture.session.endedAt = new Date();
    // Local save first so Stop/close feels instant.
    await saveTranscriptArchive(true);
    if (state.view === 'transcripts') renderTranscriptArchive();
    state.capture = null;
    setMicrophoneStatus('Not active', 'neutral');
    $('#sessionTime').textContent = '00:00:00';
    $('#sessionStat').textContent = '00:00';
    setCaptureUi(false, false, true);
    sendHealth();
    // Server finish in background — never block Stop / quit / sleep.
    void request(`/api/v1/audio/sessions/${encodeURIComponent(capture.conversationId)}/finish`, { method: 'POST' })
      .catch(() => undefined);
  })().finally(() => {
    if (state.capture === capture) capture.stopPromise = null;
  });
  return capture.stopPromise;
}

async function startCapture({ fromUser = false } = {}) {
  if (fromUser) setManuallyStopped(false);
  // Every automatic path (window re-open, PC resume, retry timer, approval poll) lands here.
  else if (isManuallyStopped()) {
    setCaptureUi(false, false, true);
    $('#captureTitle').textContent = 'Stopped';
    $('#captureMessage').textContent = 'You stopped capture. It stays off until you press Start.';
    return;
  }
  if (state.capture) return;
  if (state.captureStartPromise) return state.captureStartPromise;
  const approval = await refreshApprovalStatus();
  if (approval !== 'approved') {
    setCaptureUi(false);
    showError($('#captureError'), approval === 'rejected'
      ? 'This device was rejected. Ask an admin to approve a new registration.'
      : 'This device is waiting for admin approval. Recording cannot start yet.');
    return;
  }
  const starting = startCaptureSession();
  state.captureStartPromise = starting;
  try {
    await starting;
  } finally {
    if (state.captureStartPromise === starting) state.captureStartPromise = null;
  }
}

async function startCaptureSession() {
  showError($('#captureError'), '');
  $('#captureButton').disabled = true;
  let stream;
  let audioContext;
  try {
    const selectedDevice = $('#microphoneSelect').value || preferredMicId();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: audioCaptureConstraints(selectedDevice),
      video: false,
    });
    const activeMicId = stream.getAudioTracks()[0]?.getSettings?.()?.deviceId || selectedDevice || '';
    if (activeMicId) rememberPreferredMic(activeMicId);
    audioContext = new AudioContext();
    await audioContext.resume();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.05;
    analyser.minDecibels = -95;
    analyser.maxDecibels = -10;
    const source = audioContext.createMediaStreamSource(stream);
    const silent = audioContext.createGain();
    silent.gain.value = 0;
    source.connect(analyser);
    analyser.connect(silent);
    silent.connect(audioContext.destination);
    await refreshMicrophones(activeMicId);
    if (activeMicId) $('#microphoneSelect').value = activeMicId;
    const session = await request('/api/v1/audio/sessions', {
      method: 'POST',
      body: { store_id: state.config.storeId },
    });
    const transcriptSession = {
      id: session.conversation_id,
      fileNumber: state.nextFileNumber++,
      startedAt: new Date(),
      endedAt: null,
      status: 'LIVE',
      entries: [],
    };
    state.sessions.unshift(transcriptSession);
    if (state.sessions.length > 500) state.sessions.pop();
    saveTranscriptArchive();
    state.transcriptCount = 0;
    $('#transcriptCount').textContent = '0';
    $('#feedCount').textContent = `CAPTURE ${String(transcriptSession.fileNumber).padStart(3, '0')} · LIVE`;
    const liveEmpty = document.createElement('div');
    liveEmpty.className = 'empty-transcript';
    liveEmpty.id = 'emptyTranscript';
    const liveTitle = document.createElement('strong');
    liveTitle.textContent = 'Listening — live transcript';
    const liveNote = document.createElement('span');
    liveNote.textContent = 'Words appear while you speak. Spanish lines include an English translation underneath.';
    liveEmpty.append(liveTitle, liveNote);
    $('#transcriptList').replaceChildren(liveEmpty);
    $('#navTranscriptCount').textContent = String(state.sessions.length);
    $('#archiveTranscriptCount').textContent = String(state.sessions.length);
    state.capture = {
      conversationId: session.conversation_id,
      session: transcriptSession,
      stream,
      audioContext,
      analyser,
      requested: true,
      recorder: null,
      segmentTimer: null,
      voiceFrame: 0,
      speaking: false,
      latestPreviewText: '',
      livePartialEnglish: '',
      previewThrottle: null,
      previewSequence: 0,
      previewAppliedSequence: 0,
      spokeInSegment: false,
      segmentPeakRms: 0,
      uploadQueue: Promise.resolve(),
      inflightUploads: new Set(),
      activeUploads: 0,
      sequence: 0,
      offset: 0,
      startedAt: Date.now(),
      segmentStartedAt: 0,
      stopPromise: null,
    };
    window.clearTimeout(state.captureRetryTimer);
    setCaptureUi(true);
    setMicrophoneStatus('Microphone is active', 'ok');
    monitorVoice(state.capture);
    sendHealth({ speaking: false });
  } catch (error) {
    if (audioContext && audioContext.state !== 'closed') await audioContext.close();
    (state.capture?.stream || stream)?.getTracks().forEach((track) => track.stop());
    state.capture = null;
    setCaptureUi(false);
    window.clearTimeout(state.captureRetryTimer);
    const blockedApproval = /awaiting admin approval|approval/i.test(String(error?.message || ''));
    if (!blockedApproval) {
      state.captureRetryTimer = window.setTimeout(() => {
        if (state.config && !state.capture && state.approvalStatus === 'approved' && !isManuallyStopped()) void startCapture();
      }, 4000);
    } else {
      state.approvalStatus = 'pending';
      setApprovalBanner('pending');
    }
    setMicrophoneStatus(blockedApproval ? 'Awaiting approval' : 'Permission needed', 'bad');
    const message = error instanceof Error ? error.message : '';
    if (blockedApproval) {
      showError($('#captureError'), 'This device is waiting for admin approval. Recording cannot start yet.');
    } else if (error?.name === 'OverconstrainedError' || error?.name === 'ConstraintNotSatisfiedError') {
      showError($('#captureError'), 'The selected microphone is unavailable. Choose another input or use Default microphone.');
    } else if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError' || error?.name === 'SecurityError') {
      showError($('#captureError'), 'Microphone access was denied. Allow microphone access in Windows privacy settings, then restart capture.');
    } else if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
      showError($('#captureError'), 'No microphone was found. Connect or enable a microphone, then try again.');
    } else if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') {
      showError($('#captureError'), 'The microphone could not be opened. Close other apps using it and try again.');
    } else {
      showError($('#captureError'), message || 'Could not start microphone capture. Check Windows privacy settings and API availability.');
    }
  } finally {
    if (state.approvalStatus === 'approved') $('#captureButton').disabled = false;
  }
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#connectButton');
  button.dataset.label = 'Continue securely';
  setSetupBusy(button, true, 'Connecting…');
  showError($('#setupError'), '');
  state.apiBase = $('#apiBase').value.trim().replace(/\/+$/, '');
  try {
    const session = await request('/api/v1/auth/login', {
      method: 'POST',
      body: { email: $('#email').value.trim(), password: $('#password').value },
      apiBase: state.apiBase,
    }, null);
    state.loginToken = session.token;
    const response = await request('/api/v1/stores?page_size=100', { token: state.loginToken }, null);
    state.stores = response.stores?.items || [];
    if (!state.stores.length) throw new Error('This account has no stores available for device setup. Ask an administrator to confirm store access.');
    const select = $('#storeSelect');
    select.replaceChildren(...state.stores.map((store) => {
      const option = new Option(`${store.name} · ${store.city}, ${store.region}`, store.id);
      option.dataset.name = store.name;
      return option;
    }));
    $('#connectedAccount').textContent = session.user?.email || $('#email').value.trim();
    $('#password').value = '';
    $('#loginForm').hidden = true;
    $('#deviceForm').hidden = false;
    $('#setupTitle').textContent = 'Register this device';
    $('#stepCount').textContent = '02 / 02';
  } catch (error) {
    showError($('#setupError'), error.message || 'Could not connect to Store Listen. Check the API address and sign-in details.');
  } finally {
    setSetupBusy(button, false, 'Connecting…');
  }
});

$('#changeAccount').addEventListener('click', () => {
  state.loginToken = '';
  $('#deviceForm').hidden = true;
  $('#loginForm').hidden = false;
  $('#setupTitle').textContent = 'Connect workspace';
  $('#stepCount').textContent = '01 / 02';
  showError($('#setupError'), '');
});

$('#deviceForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#activateButton');
  button.dataset.label = 'Activate this device';
  setSetupBusy(button, true, 'Securing this PC…');
  showError($('#setupError'), '');
  try {
    const store = state.stores.find((item) => item.id === $('#storeSelect').value);
    const registration = await request('/api/v1/devices/register', {
      method: 'POST',
      body: { store_id: store.id, name: $('#deviceName').value.trim(), audio_source: 'microphone' },
      token: state.loginToken,
      apiBase: state.apiBase,
    }, null);
    const config = await window.storeListen.saveConfig({
      apiBase: state.apiBase,
      storeId: store.id,
      storeName: store.name,
      deviceId: registration.device_id,
      deviceName: $('#deviceName').value.trim(),
      deviceSecret: registration.device_secret,
    });
    await window.storeListen.setLaunchAtLogin($('#startupConsent').checked);
    state.loginToken = '';
    showWorkspace(config);
  } catch (error) {
    showError($('#setupError'), error.message || 'Device activation failed. Check the API connection and try again.');
  } finally {
    setSetupBusy(button, false, 'Securing this PC…');
  }
});

$('#captureButton').addEventListener('click', () => {
  if (state.capture) void stopCapture({ reason: 'manual' });
  else void startCapture({ fromUser: true });
});

window.storeListen.onCaptureStopRequested(async () => {
  try {
    await stopCapture({ reason: 'quit' });
  } finally {
    window.storeListen.captureStopComplete();
  }
});

window.storeListen.onWindowOpened(() => {
  if (state.config) void beginApprovedCapture();
});

window.storeListen.onSystemSuspend(async () => {
  if (state.capture) await stopCapture({ reason: 'sleep' });
});

window.storeListen.onSystemResume(() => {
  if (state.config && !state.capture && state.approvalStatus === 'approved' && !isManuallyStopped()) {
    showError($('#captureError'), '');
    void startCapture();
  }
});

$('#settingsButton').addEventListener('click', async () => {
  $('#launchAtLoginToggle').checked = await window.storeListen.getLaunchAtLogin();
  $('#settingsDialog').showModal();
});

$('#launchAtLoginToggle').addEventListener('change', (event) => {
  void window.storeListen.setLaunchAtLogin(event.target.checked);
});

$('#settingsDialog').addEventListener('close', () => $('#settingsButton').focus());

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => setActiveView(button.dataset.view));
});
$('#transcriptSearch').addEventListener('input', renderTranscriptArchive);
$('#transcriptArchiveList').addEventListener('click', async (event) => {
  const toggle = event.target.closest('button[data-session-toggle]');
  if (toggle) {
    const sessionId = toggle.dataset.sessionToggle;
    if (state.expandedSessionIds.has(sessionId)) state.expandedSessionIds.delete(sessionId);
    else state.expandedSessionIds.add(sessionId);
    renderTranscriptArchive();
    return;
  }
  const button = event.target.closest('button[data-session-id][data-format]');
  if (!button) return;
  const session = state.sessions.find((item) => item.id === button.dataset.sessionId);
  if (!session) return;
  button.disabled = true;
  try {
    const saved = await downloadTranscript(session, button.dataset.format);
    if (saved) showError($('#transcriptExportFeedback'), `Capture ${String(session.fileNumber).padStart(3, '0')} export is ready.`);
  } catch (error) {
    showError($('#transcriptExportFeedback'), error.message || 'Transcript export failed.');
  } finally {
    button.disabled = false;
  }
});

async function initialize() {
  try {
    const application = await window.storeListen.getAppConfig();
    state.apiBase = application.apiBase;
    const apiAddress = $('#apiBase');
    apiAddress.value = application.apiBase;
    apiAddress.closest('label').hidden = application.isPackaged;
    if (application.error) {
      showSetup();
      showError($('#setupError'), application.error);
      return;
    }
    void checkSetupConnection();
    state.setupHealthTimer = window.setInterval(() => void checkSetupConnection(), 15_000);
    const config = await window.storeListen.loadConfig();
    if (config?.deviceSecret && config.deviceId && config.storeId) {
      try {
        state.sessions = normalizeTranscriptSessions(await window.storeListen.loadTranscripts());
        state.nextFileNumber = state.sessions.reduce((next, session) => Math.max(next, session.fileNumber + 1), 1);
      } catch (error) {
        state.archiveError = error.message || 'Could not load the encrypted transcript archive.';
      }
      showWorkspace(config);
      return;
    }
  } catch (error) {
    showError($('#setupError'), error.message);
  }
  showSetup();
}

void initialize();
