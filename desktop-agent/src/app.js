const $ = (selector) => document.querySelector(selector);
const transcriptTools = window.StoreListenTranscript;
const voiceDetection = window.StoreListenAudioDetection || {};
const deviceHealth = window.StoreListenDeviceHealth;
const { isDeviceSessionExpired } = window.StoreListenDeviceConfig;
const { stopCaptureAndDrain } = window.StoreListenRecordingLifecycle;
const { formatUserError } = window.StoreListenErrorMessages;
const MAX_SEGMENT_MS = voiceDetection.config?.maxSegmentMs ?? 1600;
const MIN_CLIP_MS = voiceDetection.config?.minClipMs ?? 240;
const RECORDER_TIMESLICE_MS = 1000;
const PREVIEW_INTERVAL_MS = Math.max(voiceDetection.config?.previewIntervalMs ?? 900, 1200);
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
};

function showError(element, message) {
  if (!element) return;
  const formatted = formatUserError(message);
  element.textContent = formatted;
  element.hidden = !formatted;
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
    window.clearTimeout(state.reconnectTimer);
    window.clearInterval(state.setupHealthTimer);
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
  void refreshMicrophones();
  void checkApi();
  connectHealth();
  state.apiTimer = window.setInterval(checkApi, 20_000);
  state.clockTimer = window.setInterval(updateSessionClock, 1000);
  void startCapture();
}

function setDeviceStatus(online) {
  const badge = $('#deviceStatus');
  badge.classList.toggle('offline', !online);
  badge.querySelector('span').textContent = online ? 'Connected' : 'Reconnecting';
}

function setApiStatus(online) {
  const status = $('#apiStatus');
  status.innerHTML = `<i class="status-dot${online ? '' : ' bad'}"></i>${online ? 'Available' : 'Unavailable'}`;
  if (!online && !state.capture) $('#deliveryStat').innerHTML = '<i class="stat-dot pending"></i>Offline';
  else if (online && !state.capture) $('#deliveryStat').innerHTML = '<i class="stat-dot"></i>Ready';
}

async function checkApi() {
  try {
    await request('/health');
    setApiStatus(true);
  } catch {
    setApiStatus(false);
  }
}

function setMicrophoneStatus(label, type = 'neutral') {
  const status = $('#micStatus');
  status.innerHTML = `<i class="status-dot${type === 'ok' ? '' : type === 'bad' ? ' bad' : ' neutral'}"></i>${label}`;
}

async function refreshMicrophones() {
  const select = $('#microphoneSelect');
  const selected = select.value;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const microphones = devices.filter((device) => device.kind === 'audioinput');
    select.replaceChildren(new Option('Default microphone', ''));
    microphones.forEach((device, index) => {
      select.add(new Option(device.label || `Microphone ${index + 1}`, device.deviceId));
    });
    if (microphones.some((device) => device.deviceId === selected)) select.value = selected;
  } catch {
    select.replaceChildren(new Option('Default microphone', ''));
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
  state.reconnectDelay = Math.min(delay * 2, 30_000);
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

function setCaptureUi(recording, busy = false, ended = false) {
  const hero = $('#captureHero');
  hero.classList.toggle('recording', recording);
  $('#captureIndicator span').textContent = recording ? 'RECORDING' : busy ? 'STOPPING SESSION' : ended ? 'SESSION ENDED' : 'RECORDING PAUSED';
  $('#captureTitle').textContent = recording ? 'Live conversation' : busy ? 'Finishing this session.' : ended ? 'Session ended.' : 'Ready when you are.';
  $('#captureMessage').textContent = recording
    ? 'Speech is detected in milliseconds; each short phrase is sent as soon as you pause.'
    : busy ? 'Microphone is off. Completing queued transcripts and closing the conversation.' : ended ? 'The final transcript and recording are saved to conversation history.' : 'Choose the store microphone and start a secure capture session.';
  $('#captureButtonLabel').textContent = recording ? 'Stop Recording' : busy ? 'Saving transcript…' : 'Start recording';
  $('#captureButton').classList.toggle('stopping', recording);
  $('#captureButton').disabled = busy;
  $('#microphoneSelect').disabled = recording || busy;
  $('#deliveryStat').innerHTML = recording ? '<i class="stat-dot"></i>Live' : ended ? '<i class="stat-dot"></i>Ended' : '<i class="stat-dot"></i>Ready';
  if (recording) $('#captureButtonIcon').innerHTML = '<rect x="6" y="6" width="12" height="12" rx="1"/>';
  else $('#captureButtonIcon').innerHTML = '<path d="M12 3v12M8 7v7a4 4 0 0 0 8 0V7M5 12a7 7 0 0 0 14 0M12 19v3M9 22h6"/>';
}

function createTranscriptItem(segment, capturedAt, number) {
  const item = document.createElement('article');
  item.className = 'transcript-item';
  const index = document.createElement('span');
  index.className = 'transcript-number';
  index.textContent = String(number).padStart(2, '0');
  item.append(index);
  const meta = document.createElement('div');
  meta.className = 'transcript-meta';
  const speaker = document.createElement('span');
  speaker.className = 'transcript-speaker';
  speaker.textContent = segment.speakerLabel === 'Speaker not identified'
    ? 'Unattributed speaker'
    : segment.speakerLabel || 'Unattributed speaker';
  const time = document.createElement('time');
  time.className = 'transcript-time';
  time.textContent = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(capturedAt);
  meta.append(speaker, time);
  if (Number.isFinite(segment.transcriptionMs)) {
    const latency = document.createElement('span');
    latency.className = 'transcript-latency';
    latency.textContent = `STT ${(segment.transcriptionMs / 1000).toFixed(1)}s`;
    meta.append(latency);
  }
  const original = document.createElement('p');
  original.className = 'transcript-original';
  original.textContent = segment.originalText || 'No speech detected.';
  item.append(meta, original);
  if (segment.translatedText && segment.translatedText !== segment.originalText) {
    const translation = document.createElement('p');
    translation.className = 'transcript-translation';
    translation.textContent = segment.translatedText;
    item.append(translation);
  }
  const language = document.createElement('span');
  language.className = 'transcript-language';
  language.textContent = segment.language || 'und';
  item.append(language);
  return item;
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
        time: entry.capturedAt.toLocaleTimeString(),
        speaker: entry.segment.speakerLabel === 'Speaker not identified'
          ? 'Unattributed speaker'
          : entry.segment.speakerLabel || 'Unattributed speaker',
        language: entry.segment.language || 'und',
        originalText: entry.segment.originalText || 'No speech recognized.',
        translatedText: entry.segment.translatedText || '',
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
      subtitle.textContent = `${session.startedAt.toLocaleString()} · ${session.entries.length} transcript lines · ${captureDuration(session)}`;
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
        entries.slice().reverse().forEach((entry) => {
          const row = document.createElement('div');
          row.className = 'session-transcript-row';
          row.append(createTranscriptItem(entry.segment, entry.capturedAt, entry.number));
          transcript.append(row);
        });
      } else if (expanded) {
        const empty = document.createElement('p');
        empty.className = 'session-empty-lines';
        empty.textContent = session.entries.length ? 'No lines match this search.' : 'No speech recognized in this capture.';
        transcript.append(empty);
      }
      card.append(transcript);
      fragment.append(card);
    });
  }
  list.replaceChildren(fragment);
}

function renderLiveTranscript(session, partialText = '', isTranscribing = false) {
  const list = $('#transcriptList');
  const empty = $('#emptyTranscript');
  if (empty) empty.remove();
  let transcript = $('#liveTranscriptCopy');
  if (!transcript) {
    transcript = document.createElement('article');
    transcript.className = 'live-transcript-copy';
    transcript.id = 'liveTranscriptCopy';
    const original = document.createElement('p');
    original.className = 'live-transcript-original';
    original.id = 'liveTranscriptText';
    const partial = document.createElement('span');
    partial.className = 'live-transcript-current';
    const partialWords = document.createElement('span');
    partialWords.id = 'liveTranscriptPartial';
    const dots = document.createElement('span');
    dots.className = 'transcript-typing-dots';
    dots.id = 'liveTranscriptTyping';
    dots.setAttribute('role', 'status');
    dots.setAttribute('aria-label', 'Transcribing speech');
    for (let index = 0; index < 5; index += 1) dots.append(document.createElement('i'));
    partial.append(partialWords, dots);
    transcript.append(original, partial);
    list.append(transcript);
  }
  $('#liveTranscriptText').textContent = session.entries
    .map(({ segment: entrySegment }) => entrySegment.originalText || '')
    .filter(Boolean)
    .join(' ');
  const partial = $('#liveTranscriptPartial');
  partial.textContent = partialText ? ` ${partialText}` : '';
  partial.parentElement.hidden = !partialText && !isTranscribing;
  $('#liveTranscriptTyping').hidden = !isTranscribing;
  list.scrollTop = list.scrollHeight;
}

function addTranscript(segment) {
  const session = state.capture?.session;
  if (!session) return;
  const capturedAt = new Date();
  const entry = { number: session.entries.length + 1, segment, capturedAt };
  session.entries.push(entry);
  if (state.capture) state.capture.latestPreviewText = '';
  saveTranscriptArchive();
  renderLiveTranscript(session);
  state.transcriptCount += 1;
  $('#transcriptCount').textContent = String(state.transcriptCount);
  $('#navTranscriptCount').textContent = String(state.sessions.length);
  $('#archiveTranscriptCount').textContent = String(state.sessions.length);
  $('#feedCount').textContent = `LIVE · ${state.transcriptCount}`;
  const timestamp = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date());
  $('#lastTranscript').textContent = Number.isFinite(segment.transcriptionMs)
    ? `${timestamp} · STT ${(segment.transcriptionMs / 1000).toFixed(1)}s`
    : timestamp;
  $('#deliveryStat').innerHTML = '<i class="stat-dot"></i>Live';
  if (state.view === 'transcripts') renderTranscriptArchive();
}

async function uploadSegment(capture, blob, sequence, offset, duration) {
  if (!blob.size) return;
  $('#deliveryStat').innerHTML = '<i class="stat-dot pending"></i>Sending';
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
    transcriptionMs: response.transcription_ms,
    roundTripMs: Math.round(performance.now() - uploadStartedAt),
  });
  else {
    capture.latestPreviewText = '';
    renderLiveTranscript(capture.session);
    if (response.analysis_status === 'unsupported_language') {
      showError($('#captureError'), 'Speech was detected, but this setup supports English, Spanish, Hindi, and Urdu.');
    }
  }
  if (response.segment) showError($('#captureError'), '');
  $('#deliveryStat').innerHTML = '<i class="stat-dot"></i>Live';
  setApiStatus(true);
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
  const recorder = new MediaRecorder(capture.stream, { mimeType, audioBitsPerSecond: 64_000 });
  const chunks = [];
  const startedAt = Date.now();
  let previewInFlight = false;
  let lastPreviewAt = 0;
  let previewSequence = 0;
  capture.recorder = recorder;
  capture.segmentStartedAt = startedAt;
  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    chunks.push(event.data);
    const now = Date.now();
    if (recorder.state !== 'recording' || !capture.requested || previewInFlight
      || now - startedAt < PREVIEW_INTERVAL_MS || now - lastPreviewAt < PREVIEW_INTERVAL_MS) return;
    previewInFlight = true;
    lastPreviewAt = now;
    const previewBlob = new Blob(chunks, { type: mimeType });
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
            preview_sequence: ++previewSequence,
          },
        });
        const partialText = response.segment?.originalText;
        if (partialText && capture.requested && capture.recorder === recorder) {
          capture.latestPreviewText = partialText;
          renderLiveTranscript(capture.session, partialText, true);
        }
      } catch {
        // Final transcription remains authoritative if a provisional preview fails.
      } finally {
        previewInFlight = false;
      }
    })();
  };
  recorder.onerror = () => {
    showError($('#captureError'), 'Microphone recording failed. Check the selected input and Windows microphone permissions.');
    capture.requested = false;
  };
  recorder.onstop = () => {
    if (capture.recorder === recorder) capture.recorder = null;
    clearTimeout(capture.segmentTimer);
    const blob = new Blob(chunks, { type: mimeType });
    const durationMs = Date.now() - startedAt;
    const duration = Math.max(durationMs / 1000, 0.1);
    const offset = Math.max((startedAt - capture.startedAt) / 1000, 0);
    capture.offset = offset + duration;
    if (blob.size && durationMs >= MIN_CLIP_MS) {
      const sequence = ++capture.sequence;
      capture.uploadQueue = capture.uploadQueue.then(() => uploadSegment(capture, blob, sequence, offset, duration)).catch(async (error) => {
        if (await returnToDeviceActivation(error)) return;
        showError($('#captureError'), `${error.message} Capture is pausing so audio is not silently lost.`);
        capture.requested = false;
        setApiStatus(false);
        window.setTimeout(() => { void stopCapture(); }, 0);
      });
    }
    if (capture.requested && capture.speaking) beginRecorder(capture);
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
  const tick = () => {
    if (!capture.requested) return;
    capture.analyser.getFloatTimeDomainData(samples);
    capture.analyser.getFloatFrequencyData(spectrum);
    const result = gate
      ? gate.observe(samples, spectrum, capture.audioContext.sampleRate, performance.now())
      : { state: (voiceDetection.shouldVoiceTrigger?.(samples) ? 'start' : 'idle') };
    if (result.state === 'start') {
      capture.speaking = true;
      renderLiveTranscript(capture.session, capture.latestPreviewText || '', true);
      $('#captureTitle').textContent = 'Voice detected';
      $('#captureMessage').textContent = 'Capturing this phrase now; the same line will appear on the dashboard immediately after transcription.';
      sendHealth({ speaking: true });
      beginRecorder(capture);
    } else if (result.state === 'end') {
      capture.speaking = false;
      sendHealth({ speaking: false });
      if (capture.recorder?.state === 'recording') {
        const elapsed = Date.now() - (capture.segmentStartedAt || Date.now());
        if (elapsed >= MIN_CLIP_MS) capture.recorder.stop();
        else capture.segmentTimer = window.setTimeout(() => {
          if (capture.recorder?.state === 'recording') capture.recorder.stop();
        }, MIN_CLIP_MS - elapsed);
      }
    }
    capture.voiceFrame = window.requestAnimationFrame(tick);
  };
  capture.voiceFrame = window.requestAnimationFrame(tick);
}

async function stopCapture() {
  if (state.captureStartPromise) await state.captureStartPromise;
  const capture = state.capture;
  if (!capture) return;
  if (capture.stopPromise) return capture.stopPromise;
  capture.requested = false;
  capture.speaking = false;
  setCaptureUi(false, true);
  clearTimeout(capture.segmentTimer);
  if (capture.voiceFrame) window.cancelAnimationFrame(capture.voiceFrame);
  capture.stopPromise = (async () => {
    await stopCaptureAndDrain(capture, () => setMicrophoneStatus('Not active', 'neutral'));
    let serverEnded = true;
    try {
      await request(`/api/v1/audio/sessions/${encodeURIComponent(capture.conversationId)}/finish`, { method: 'POST' });
    } catch (error) {
      serverEnded = false;
      showError($('#captureError'), `Capture stopped, but the server could not close this conversation: ${error.message}`);
    }
    capture.session.status = 'ENDED';
    capture.session.endedAt = new Date();
    await saveTranscriptArchive(true);
    if (state.view === 'transcripts') renderTranscriptArchive();
    state.capture = null;
    setMicrophoneStatus('Not active', 'neutral');
    $('#sessionTime').textContent = '00:00:00';
    $('#sessionStat').textContent = '00:00';
    setCaptureUi(false, false, serverEnded);
    sendHealth();
  })().finally(() => {
    if (state.capture === capture) capture.stopPromise = null;
  });
  return capture.stopPromise;
}

async function startCapture() {
  if (state.capture) return;
  if (state.captureStartPromise) return state.captureStartPromise;
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
    const selectedDevice = $('#microphoneSelect').value;
    const audioConstraints = selectedDevice ? { deviceId: { ideal: selectedDevice } } : true;
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    audioContext = new AudioContext();
    await audioContext.resume();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0;
    const source = audioContext.createMediaStreamSource(stream);
    const silent = audioContext.createGain();
    silent.gain.value = 0;
    source.connect(analyser);
    analyser.connect(silent);
    silent.connect(audioContext.destination);
    await refreshMicrophones();
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
    liveTitle.textContent = 'Listening for the current conversation';
    const liveNote = document.createElement('span');
    liveNote.textContent = 'Newest recognized speech appears at the top.';
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
      uploadQueue: Promise.resolve(),
      sequence: 0,
      offset: 0,
      startedAt: Date.now(),
      segmentStartedAt: 0,
      stopPromise: null,
    };
    setCaptureUi(true);
    setMicrophoneStatus('Active', 'ok');
    monitorVoice(state.capture);
    sendHealth({ speaking: false });
  } catch (error) {
    if (audioContext && audioContext.state !== 'closed') await audioContext.close();
    (state.capture?.stream || stream)?.getTracks().forEach((track) => track.stop());
    state.capture = null;
    setCaptureUi(false);
    setMicrophoneStatus('Permission needed', 'bad');
    const message = error instanceof Error ? error.message : '';
    if (error?.name === 'OverconstrainedError' || error?.name === 'ConstraintNotSatisfiedError') {
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
    $('#captureButton').disabled = false;
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
  if (state.capture?.requested) void stopCapture();
  else if (state.capture) void stopCapture();
  else void startCapture();
});

window.storeListen.onCaptureStopRequested(async () => {
  try {
    await stopCapture();
  } finally {
    window.storeListen.captureStopComplete();
  }
});

window.storeListen.onWindowOpened(() => {
  if (state.config) void startCapture();
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
