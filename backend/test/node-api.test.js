import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { readAudioClip } from '../src/audio-storage.js';
import { AuditLog, Store, User } from '../src/models.js';
import { createAccessToken, hashDeviceSecret, verifyPassword } from '../src/auth.js';

const secret = 'test-jwt-secret-that-is-long-enough-for-hmac';
const user = {
  id: 'user-1',
  email: 'manager@example.com',
  full_name: 'Store Manager',
  password_hash: '',
  role: 'STORE_MANAGER',
  organization_id: 'org-1',
  store_id: 'store-1',
  is_active: true,
};
const adminUser = { ...user, id: 'admin-1', email: 'admin@example.com', role: 'ORG_ADMIN' };
const foreignAdminUser = { ...adminUser, id: 'admin-2', email: 'foreign-admin@example.com', organization_id: 'org-2', store_id: null };
const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
user.password_hash = `pbkdf2$180000$${salt.toString('hex')}$${pbkdf2Sync('correct horse battery staple', salt, 180000, 32, 'sha256').toString('hex')}`;

const stores = [
  { id: 'store-1', organization_id: 'org-1', name: 'North Store', city: 'Dallas', region: 'TX' },
  { id: 'store-2', organization_id: 'org-2', name: 'Other Store', city: 'Austin', region: 'TX' },
];
const auditRows = [];
const conversations = [];
const recordings = [];
const transcriptSegments = [];
const aiRuns = [];
const intents = [];
const dailyReports = [];
const publishedEvents = [];
let testConfig;
const stockItems = [];
const storeRules = [];
const employees = [];
const opportunities = [];
const transactions = [];
const transactionItems = [];
const devcoreTasks = [];
const deviceSecret = 'device-secret-for-tests-only';
const device = {
  id: 'device-1',
  store_id: 'store-1',
  status: 'registered',
  approval_status: 'approved',
  secret_hash: hashDeviceSecret(deviceSecret),
  revoked: false,
};
const devices = [device];
let audioDirectory;
function matchesFilter(row, filter = {}) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = row[key];
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      if (expected.$in && !expected.$in.includes(actual)) return false;
      if (expected.$nin && expected.$nin.includes(actual)) return false;
      if (expected.$ne !== undefined && actual === expected.$ne) return false;
      if (expected.$gte && new Date(actual) < new Date(expected.$gte)) return false;
      if (expected.$lt && new Date(actual) >= new Date(expected.$lt)) return false;
      if (expected.$gt && new Date(actual) <= new Date(expected.$gt)) return false;
      return true;
    }
    return actual === expected;
  });
}

function arrayQuery(rows) {
  let output = [...rows];
  return {
    sort() { return this; },
    select() { return this; },
    skip(count) { output = output.slice(count); return this; },
    limit(count) { output = output.slice(0, count); return this; },
    lean: async () => output.map((row) => ({ ...row })),
  };
}

function mutableModel(rows) {
  return {
    create: async (row) => { rows.push({ ...row }); return row; },
    find: (filter) => arrayQuery(rows.filter((row) => matchesFilter(row, filter))),
    countDocuments: async (filter) => rows.filter((row) => matchesFilter(row, filter)).length,
    findOne(filter) {
      const matched = rows.find((row) => matchesFilter(row, filter));
      if (!matched) return { lean: async () => null, then: (resolve) => resolve(null) };
      const document = {
        ...matched,
        save: async function save() {
          for (const [key, value] of Object.entries(this)) if (typeof value !== 'function') matched[key] = value;
        },
        toObject() { return { ...this }; },
      };
      return {
        lean: async () => ({ ...matched }),
        then: (resolve, reject) => Promise.resolve(document).then(resolve, reject),
      };
    },
    deleteOne: async (filter) => {
      const index = rows.findIndex((row) => matchesFilter(row, filter));
      if (index >= 0) rows.splice(index, 1);
    },
    deleteMany: async (filter) => {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (matchesFilter(rows[index], filter)) rows.splice(index, 1);
      }
      return { deletedCount: before - rows.length };
    },
  };
}

const UserModel = {
  findOne(filter) {
    const matched = [user, adminUser, foreignAdminUser].find((item) => item.email === filter.email || (item.id === filter.id && filter.is_active?.$ne === false));
    return { lean: async () => matched ? { ...matched } : null };
  },
  find(filter) {
    return arrayQuery([user, adminUser, foreignAdminUser].filter((item) => matchesFilter(item, filter)));
  },
};
const StoreModel = mutableModel(stores);
const AuditLogModel = { create: async (row) => auditRows.push(row) };
const DeviceModel = {
  create: async (row) => { devices.push(row); return row; },
  findOne(filter) {
    const matched = devices.find((item) => item.id === filter.id);
    if (!matched) return { lean: async () => null, then: (resolve) => resolve(null) };
    const document = {
      ...matched,
      save: async function save() {
        const index = devices.findIndex((item) => item.id === this.id);
        devices[index] = { ...this };
      },
    };
    return {
      lean: async () => ({ ...matched }),
      then: (resolve, reject) => Promise.resolve(document).then(resolve, reject),
    };
  },
  find(filter) {
    return {
      lean: async () => devices.filter((item) => matchesFilter(item, filter))
        .map((item) => ({ ...item })),
    };
  },
  countDocuments: async (filter) => devices.filter((item) => matchesFilter(item, filter)).length,
};
let server;
let baseUrl;

before(async () => {
  audioDirectory = await mkdtemp(path.join(tmpdir(), 'store-listen-node-test-'));
  const ConversationModel = {
    create: async (row) => { conversations.push(row); return row; },
    findOne: (filter) => {
      const conversation = conversations.find((row) => matchesFilter(row, filter));
      if (!conversation) return { lean: async () => null };
      return {
        ...conversation,
        lean: async () => ({ ...conversation }),
        save: async function save() {
          const index = conversations.findIndex((row) => row.id === this.id);
          conversations[index] = { ...conversation, status: this.status, ended_at: this.ended_at };
        },
      };
    },
    find: (filter) => arrayQuery(conversations.filter((row) => matchesFilter(row, filter))),
    countDocuments: async (filter) => conversations.filter((row) => matchesFilter(row, filter)).length,
    deleteMany: async (filter) => {
      const before = conversations.length;
      for (let index = conversations.length - 1; index >= 0; index -= 1) {
        if (matchesFilter(conversations[index], filter)) conversations.splice(index, 1);
      }
      return { deletedCount: before - conversations.length };
    },
    updateOne: async (filter, update) => {
      const row = conversations.find((item) => item.id === filter.id);
      if (row) Object.assign(row, update.$set || {});
    },
  };
  const AudioRecordingModel = {
    create: async (row) => { recordings.push(row); return row; },
    countDocuments: async (filter) => recordings.filter((row) => matchesFilter(row, filter)).length,
    deleteMany: async (filter) => {
      const before = recordings.length;
      for (let index = recordings.length - 1; index >= 0; index -= 1) {
        if (matchesFilter(recordings[index], filter)) recordings.splice(index, 1);
      }
      return { deletedCount: before - recordings.length };
    },
    findOne: (filter) => ({ lean: async () => recordings.find((row) => matchesFilter(row, filter)) || null }),
    find: (filter) => arrayQuery(recordings.filter((row) => matchesFilter(row, filter))),
  };
  const TranscriptSegmentModel = {
    create: async (row) => { transcriptSegments.push(row); return row; },
    findOne: (filter) => mutableModel(transcriptSegments).findOne(filter),
    countDocuments: async (filter) => transcriptSegments.filter((row) => matchesFilter(row, filter)).length,
    find: (filter) => arrayQuery(transcriptSegments.filter((row) => matchesFilter(row, filter))),
    deleteMany: async (filter) => {
      const before = transcriptSegments.length;
      for (let index = transcriptSegments.length - 1; index >= 0; index -= 1) {
        if (matchesFilter(transcriptSegments[index], filter)) transcriptSegments.splice(index, 1);
      }
      return { deletedCount: before - transcriptSegments.length };
    },
  };
  testConfig = {
    appEnv: 'test',
    demoMode: true,
    aiProvider: 'rules',
    speechProvider: 'deepgram',
    posProvider: 'mock',
    storageProvider: 'local',
    deepgramApiKey: 'test-deepgram-key',
    audioStorageDir: audioDirectory,
    audioRetentionDays: 7,
    transcriptRetentionDays: 30,
    corsOrigins: ['http://localhost:3000'],
    corsOriginRegex: '^https://.*\\.ts\\.net$',
    jwtSecret: secret,
  };
  const participantModel = mutableModel([]);
  const app = createApp({
    config: testConfig,
    mongoose: { connection: { readyState: 1 } },
    UserModel,
    StoreModel,
    AuditLogModel,
    DeviceModel,
    ConversationModel,
    TranscriptSegmentModel,
    ParticipantModel: participantModel,
    AudioRecordingModel,
    StockItemModel: mutableModel(stockItems),
    StoreRuleModel: mutableModel(storeRules),
    EmployeeModel: mutableModel(employees),
    EmployeePerformanceModel: mutableModel([]),
    OpportunityModel: mutableModel(opportunities),
    SalesRecommendationModel: mutableModel([]),
    AiProcessingRunModel: mutableModel(aiRuns),
    CustomerIntentModel: mutableModel(intents),
    DailyReportModel: mutableModel(dailyReports),
    IntegrationConnectionModel: mutableModel([]),
    DevcoreTaskModel: mutableModel(devcoreTasks),
    PosTransactionModel: mutableModel(transactions),
    PosTransactionItemModel: mutableModel(transactionItems),
    sockets: { publish: (room, event) => publishedEvents.push({ room, event }) },
    deepgramTranscriber: async () => ({
      transcript: 'Hola, necesito un cargador.',
      language: 'es',
      confidence: 0.97,
      requestId: 'request-test',
    }),
    englishTranslator: async () => 'Hello, I need a charger.',
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (audioDirectory) await rm(audioDirectory, { recursive: true, force: true });
});

test('legacy PBKDF2 password hashes verify without migration', () => {
  assert.equal(verifyPassword('correct horse battery staple', user.password_hash), true);
  assert.equal(verifyPassword('wrong password', user.password_hash), false);
});

test('readiness reports database, deployment mode, and transcription capability', async () => {
  const [health, ready] = await Promise.all([
    fetch(`${baseUrl}/health`),
    fetch(`${baseUrl}/ready`),
  ]);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {
    status: 'ready',
    mode: 'demo',
    database: 'connected',
    capabilities: { transcription: 'available' },
  });
  const configuredKey = testConfig.deepgramApiKey;
  try {
    delete testConfig.deepgramApiKey;
    const missingTranscriber = await fetch(`${baseUrl}/ready`);
    assert.equal(missingTranscriber.status, 200);
    assert.deepEqual((await missingTranscriber.json()).capabilities, { transcription: 'unavailable' });
  } finally {
    testConfig.deepgramApiKey = configuredKey;
  }
});

test('login preserves the React client token response and audit log', async () => {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: 'correct horse battery staple' }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(typeof payload.token, 'string');
  assert.equal(payload.user.id, user.id);
  assert.match(response.headers.get('set-cookie') || '', /sl_session=/);
  assert.equal(auditRows.at(-1).action, 'login');
});

test('store list and detail are limited to the authenticated organization', async () => {
  const token = createAccessToken(user, secret);
  const headers = { Authorization: `Bearer ${token}` };
  const list = await fetch(`${baseUrl}/api/v1/stores?page_size=100`, { headers });
  const body = await list.json();
  assert.deepEqual(body.stores.items.map((store) => store.id), ['store-1']);

  const forbidden = await fetch(`${baseUrl}/api/v1/stores/store-2`, { headers });
  assert.equal(forbidden.status, 404);
});

test('audio session lifecycle stores recordings without retranscribing', async () => {
  const token = createAccessToken(user, secret);
  const headers = { Authorization: `Bearer ${token}` };
  const started = await fetch(`${baseUrl}/api/v1/audio/sessions`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ store_id: 'store-1' }),
  });
  assert.equal(started.status, 201);
  const session = await started.json();

  const form = new FormData();
  form.set('store_id', 'store-1');
  form.set('conversation_id', session.conversation_id);
  form.set('capture_sequence', '1');
  form.set('duration_seconds', '4.8');
  form.set('audio', new Blob([Buffer.from([1, 2, 3, 4])], { type: 'audio/webm' }), 'clip.webm');
  const upload = await fetch(`${baseUrl}/api/v1/audio/recordings`, { method: 'POST', headers, body: form });
  assert.equal(upload.status, 201, await upload.text());
  assert.equal(recordings[0].conversation_id, session.conversation_id);
  assert.equal(recordings[0].byte_size, 4);
  assert.equal(recordings[0].duration_seconds, 4.8);

  const finished = await fetch(`${baseUrl}/api/v1/audio/sessions/${session.conversation_id}/finish`, { method: 'POST', headers });
  const result = await finished.json();
  assert.equal(finished.status, 200);
  assert.equal(result.status, 'ENDED');
  assert.equal(result.recordings, 1);
});

test('multipart speech transcription sends English text and persists Deepgram transcript', async () => {
  const headers = { Authorization: `Bearer ${createAccessToken(user, secret)}` };
  const sessionResponse = await fetch(`${baseUrl}/api/v1/audio/sessions`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ store_id: 'store-1' }),
  });
  const session = await sessionResponse.json();
  const form = new FormData();
  form.set('store_id', 'store-1');
  form.set('conversation_id', session.conversation_id);
  form.set('speaker_role', 'customer');
  form.set('capture_sequence', '12');
  form.set('duration_seconds', '3.5');
  form.set('audio', new Blob([Buffer.from([11, 12])], { type: 'audio/webm' }), 'utterance.webm');

  const response = await fetch(`${baseUrl}/api/v1/audio/transcribe`, { method: 'POST', headers, body: form });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.speech_provider, 'deepgram');
  assert.equal(payload.segment.language, 'es');
  assert.equal(payload.segment.englishText, 'Hello, I need a charger.');
  assert.equal(payload.translation_status, 'translated');
  assert.equal(payload.request_id, 'request-test');
  assert.equal(transcriptSegments.some((row) => row.id === payload.segment.segmentId), true);
  assert.equal(recordings.some((row) => row.id === payload.audio_recording_id), true);
});

test('device approval endpoint authenticates the stored device secret', async () => {
  const response = await fetch(`${baseUrl}/api/v1/devices/device-1/approval`, {
    headers: { Authorization: `Bearer ${deviceSecret}`, 'X-Device-ID': 'device-1' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    device_id: 'device-1',
    approval_status: 'approved',
    approved: true,
    status: 'registered',
    revoked: false,
  });
});

test('new device stays pending until an organization admin approves it', async () => {
  const managerToken = createAccessToken(user, secret);
  const registered = await fetch(`${baseUrl}/api/v1/devices/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${managerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ store_id: 'store-1', name: 'Front register' }),
  });
  const registration = await registered.json();
  assert.equal(registered.status, 201);
  assert.equal(registration.approval_status, 'pending');

  const blocked = await fetch(`${baseUrl}/api/v1/audio/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${registration.device_secret}`, 'X-Device-ID': registration.device_id, 'content-type': 'application/json' },
    body: JSON.stringify({ store_id: 'store-1' }),
  });
  assert.equal(blocked.status, 403);

  const adminToken = createAccessToken(adminUser, secret);
  const pending = await fetch(`${baseUrl}/api/v1/devices/pending`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal((await pending.json()).devices.some((item) => item.id === registration.device_id), true);

  const approved = await fetch(`${baseUrl}/api/v1/devices/${registration.device_id}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(approved.status, 200, await approved.text());

  const allowed = await fetch(`${baseUrl}/api/v1/audio/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${registration.device_secret}`, 'X-Device-ID': registration.device_id, 'content-type': 'application/json' },
    body: JSON.stringify({ store_id: 'store-1' }),
  });
  assert.equal(allowed.status, 201);
});

test('conversation transcript and recording reads preserve existing API contracts and org scope', async () => {
  const conversationId = 'conv-read-test';
  const recordingId = 'audio-read-test';
  const startedAt = new Date();
  conversations.push({ id: conversationId, store_id: 'store-1', status: 'ENDED', primary_language: 'es', started_at: startedAt, ended_at: startedAt, opportunity_status: 'UNKNOWN' });
  transcriptSegments.push({
    id: 'segment-read-test',
    conversation_id: conversationId,
    speaker_id: 'speaker-unknown',
    language: 'es',
    original_text: 'Hola, necesito un cargador.',
    translated_text: 'Hello, I need a charger.',
    start_time: 0,
    end_time: 2,
    confidence: 0.96,
    is_final: true,
    created_at: startedAt,
  });
  recordings.push({
    id: recordingId,
    store_id: 'store-1',
    conversation_id: conversationId,
    storage_key: '2026/10/20/read-test.webm',
    content_type: 'audio/webm',
    byte_size: 4,
    duration_seconds: 2,
    sequence: 1,
    captured_at: startedAt,
    retain_until: new Date(Date.now() + 60_000),
  });

  const headers = { Authorization: `Bearer ${createAccessToken(user, secret)}` };
  const list = await fetch(`${baseUrl}/api/v1/conversations?status=ENDED&page_size=10`, { headers });
  const listBody = await list.json();
  assert.equal(list.status, 200);
  assert.equal(listBody.conversations.items.some((item) => item.id === conversationId), true);

  const transcript = await fetch(`${baseUrl}/api/v1/conversations/${conversationId}/transcript`, { headers });
  const transcriptBody = await transcript.json();
  assert.equal(transcript.status, 200);
  assert.equal(transcriptBody.segments[0].english_text, 'Hello, I need a charger.');

  const library = await fetch(`${baseUrl}/api/v1/recordings?store_id=store-1&page_size=10`, { headers });
  const libraryBody = await library.json();
  assert.equal(library.status, 200);
  assert.equal(libraryBody.recordings.find((item) => item.id === recordingId).transcript_snippet, 'Hello, I need a charger.');

  const forbidden = await fetch(`${baseUrl}/api/v1/conversations/foreign-conversation`, { headers });
  assert.equal(forbidden.status, 404);
});

test('deleting a conversation recording removes its file, transcript, and conversation rows', async () => {
  const headers = {
    Authorization: `Bearer ${createAccessToken(user, secret)}`,
    'content-type': 'application/json',
  };
  const started = await fetch(`${baseUrl}/api/v1/audio/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ store_id: 'store-1' }),
  });
  const session = await started.json();
  assert.equal(started.status, 201);

  const form = new FormData();
  form.set('store_id', 'store-1');
  form.set('conversation_id', session.conversation_id);
  form.set('audio', new Blob([Buffer.from([5, 6, 7])], { type: 'audio/webm' }), 'delete.webm');
  const uploaded = await fetch(`${baseUrl}/api/v1/audio/recordings`, { method: 'POST', headers: { Authorization: headers.Authorization }, body: form });
  assert.equal(uploaded.status, 201);
  const recording = recordings.at(-1);
  transcriptSegments.push({ id: 'segment-delete-test', conversation_id: session.conversation_id, original_text: 'Hello', translated_text: 'Hello' });

  const deleted = await fetch(`${baseUrl}/api/v1/recordings/${recording.id}`, { method: 'DELETE', headers });
  const result = await deleted.json();
  assert.equal(deleted.status, 200);
  assert.equal(result.deleted, true);
  assert.equal(result.counts.conversations, 1);
  assert.equal(result.counts.recordings, 1);
  assert.equal(result.counts.transcript_segments, 1);
  assert.equal(conversations.some((row) => row.id === session.conversation_id), false);
  assert.equal(transcriptSegments.some((row) => row.id === 'segment-delete-test'), false);
  await assert.rejects(readAudioClip(recording.storage_key, audioDirectory), { code: 'ENOENT' });
});

test('bulk recording delete requires exact confirmation and reports scoped misses', async () => {
  const headers = {
    authorization: `Bearer ${createAccessToken(user, secret)}`,
    'content-type': 'application/json',
  };
  const started = await fetch(`${baseUrl}/api/v1/audio/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ store_id: 'store-1' }),
  });
  const session = await started.json();
  const form = new FormData();
  form.set('store_id', 'store-1');
  form.set('conversation_id', session.conversation_id);
  form.set('audio', new Blob([Buffer.from([8, 9])], { type: 'audio/webm' }), 'bulk-delete.webm');
  await fetch(`${baseUrl}/api/v1/audio/recordings`, { method: 'POST', headers: { Authorization: headers.Authorization }, body: form });
  const recording = recordings.at(-1);

  const unconfirmed = await fetch(`${baseUrl}/api/v1/recordings/bulk-delete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ recording_ids: [recording.id], confirm: 'wrong' }),
  });
  assert.equal(unconfirmed.status, 400);

  const deleted = await fetch(`${baseUrl}/api/v1/recordings/bulk-delete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ recording_ids: [recording.id, 'not-in-scope'], confirm: 'DELETE' }),
  });
  const result = await deleted.json();
  assert.equal(deleted.status, 200);
  assert.equal(result.matched, 1);
  assert.deepEqual(result.missing_ids, ['not-in-scope']);
  assert.equal(result.deleted.conversations, 1);
  assert.equal(result.deleted.recordings, 1);
});

test('wipe-all requires the explicit phrase and stays inside the actor store scope', async () => {
  const headers = {
    Authorization: `Bearer ${createAccessToken(user, secret)}`,
    'content-type': 'application/json',
  };
  const started = await fetch(`${baseUrl}/api/v1/audio/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ store_id: 'store-1' }),
  });
  const session = await started.json();
  const refused = await fetch(`${baseUrl}/api/v1/recordings/bulk-delete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ wipe_all: true, store_id: 'store-2', confirm: 'DELETE ALL RECORDINGS' }),
  });
  assert.equal(refused.status, 403);

  const wiped = await fetch(`${baseUrl}/api/v1/recordings/bulk-delete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ wipe_all: true, confirm: 'DELETE ALL RECORDINGS' }),
  });
  const result = await wiped.json();
  assert.equal(wiped.status, 200);
  assert.equal(result.wipe_all, true);
  assert.equal(result.store_id, 'store-1');
  assert.equal(result.deleted.conversations >= 1, true);
  assert.equal(conversations.some((row) => row.id === session.conversation_id), false);
});

test('inventory and store rules support scoped create, update, conflicts, and delete', async () => {
  const headers = {
    Authorization: `Bearer ${createAccessToken(adminUser, secret)}`,
    'content-type': 'application/json',
  };
  const createdStock = await fetch(`${baseUrl}/api/v1/inventory`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ store_id: 'store-1', sku: 'cbl-1', name: 'Cable', cost: 2, price: 5, quantity: 4, par_level: 2 }),
  });
  assert.equal(createdStock.status, 201);
  const stock = await createdStock.json();
  assert.equal(stock.sku, 'CBL-1');
  assert.equal(stock.quantity, 4);

  const duplicateStock = await fetch(`${baseUrl}/api/v1/inventory`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ store_id: 'store-1', sku: 'CBL-1', name: 'Duplicate' }),
  });
  assert.equal(duplicateStock.status, 409);

  const updatedStock = await fetch(`${baseUrl}/api/v1/inventory/${stock.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ quantity: 1 }),
  });
  assert.equal(updatedStock.status, 200);
  assert.equal((await updatedStock.json()).quantity, 1);

  const createdRule = await fetch(`${baseUrl}/api/v1/rules`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      store_id: 'store-1',
      name: 'Cable offer',
      dollar_value: 20,
      trigger_condition: 'Customer asks for a cable',
      expected_action: 'Offer a charger',
    }),
  });
  assert.equal(createdRule.status, 201);
  const rule = await createdRule.json();
  assert.equal(rule.active, true);

  const updatedRule = await fetch(`${baseUrl}/api/v1/rules/${rule.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ active: false }),
  });
  assert.equal(updatedRule.status, 200);
  assert.equal((await updatedRule.json()).active, false);

  const foreignStock = await fetch(`${baseUrl}/api/v1/inventory/${stock.id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${createAccessToken(foreignAdminUser, secret)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ quantity: 99 }),
  });
  assert.equal(foreignStock.status, 404);

  const removedStock = await fetch(`${baseUrl}/api/v1/inventory/${stock.id}`, { method: 'DELETE', headers });
  const removedRule = await fetch(`${baseUrl}/api/v1/rules/${rule.id}`, { method: 'DELETE', headers });
  assert.equal(removedStock.status, 204);
  assert.equal(removedRule.status, 204);
});

test('organization admins can create, update, and safely delete unreferenced stores', async () => {
  const headers = {
    Authorization: `Bearer ${createAccessToken(adminUser, secret)}`,
    'content-type': 'application/json',
  };
  const created = await fetch(`${baseUrl}/api/v1/stores`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'South Store', code: 'SOUTH', city: 'Austin', region: 'TX' }),
  });
  assert.equal(created.status, 201);
  const store = await created.json();
  assert.equal(store.organization_id, 'org-1');
  assert.equal(store.timezone, 'America/Chicago');

  const duplicate = await fetch(`${baseUrl}/api/v1/stores`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Duplicate', code: 'SOUTH', city: 'Austin', region: 'TX' }),
  });
  assert.equal(duplicate.status, 409);

  const updated = await fetch(`${baseUrl}/api/v1/stores/${store.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ name: 'South Austin Store' }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).name, 'South Austin Store');

  const deleted = await fetch(`${baseUrl}/api/v1/stores/${store.id}`, { method: 'DELETE', headers });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { id: store.id, deleted: true });
});

test('employee management preserves history by deactivating employees and scopes reviews', async () => {
  const headers = {
    Authorization: `Bearer ${createAccessToken(adminUser, secret)}`,
    'content-type': 'application/json',
  };
  const created = await fetch(`${baseUrl}/api/v1/employees`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ store_id: 'store-1', name: 'Jordan Chen', role: 'Sales associate' }),
  });
  assert.equal(created.status, 201);
  const employee = await created.json();
  assert.equal(employee.active, true);

  const updated = await fetch(`${baseUrl}/api/v1/employees/${employee.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ name: 'Jordan C.' }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).name, 'Jordan C.');

  const performance = await fetch(`${baseUrl}/api/v1/employees/${employee.id}/performance`, { headers });
  const performanceBody = await performance.json();
  assert.equal(performance.status, 200);
  assert.equal(performanceBody.employeeId, employee.id);
  assert.equal(performanceBody.aiAssistedMetric, true);

  const archived = await fetch(`${baseUrl}/api/v1/employees/${employee.id}`, { method: 'DELETE', headers });
  assert.deepEqual(await archived.json(), { id: employee.id, active: false });
  const listing = await fetch(`${baseUrl}/api/v1/employees?store_id=store-1`, { headers });
  assert.equal((await listing.json()).employees.some((row) => row.id === employee.id), false);
});

test('managers can review only in-scope opportunities with validated notes', async () => {
  opportunities.push({
    id: 'opportunity-review-test',
    store_id: 'store-1',
    conversation_id: 'conversation-review-test',
    customer_intent: 'charger',
    product_name: 'Charger',
    status: 'OPEN',
    confidence: 0.8,
    recommendation: 'Offer compatible charger',
    created_at: new Date(),
  });
  const headers = {
    Authorization: `Bearer ${createAccessToken(user, secret)}`,
    'content-type': 'application/json',
  };
  const reviewed = await fetch(`${baseUrl}/api/v1/opportunities/opportunity-review-test`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'CONVERTED', manager_note: 'Customer accepted.' }),
  });
  assert.equal(reviewed.status, 200);
  const body = await reviewed.json();
  assert.equal(body.status, 'CONVERTED');
  assert.equal(body.manager_note, 'Customer accepted.');

  const invalid = await fetch(`${baseUrl}/api/v1/opportunities/opportunity-review-test`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'NOT_A_STATUS' }),
  });
  assert.equal(invalid.status, 422);

  const foreign = await fetch(`${baseUrl}/api/v1/opportunities/opportunity-review-test`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${createAccessToken(foreignAdminUser, secret)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'MISSED' }),
  });
  assert.equal(foreign.status, 404);
});

test('settings and POS reads expose scoped provider and transaction data', async () => {
  transactions.push({
    id: 'pos-read-test',
    store_id: 'store-1',
    employee_id: 'employee-1',
    amount: 24.5,
    currency: 'USD',
    occurred_at: new Date(),
    provider: 'live',
  });
  transactionItems.push({ id: 'pos-line-read-test', transaction_id: 'pos-read-test', name: 'USB-C Charger' });
  const headers = { Authorization: `Bearer ${createAccessToken(user, secret)}` };

  const settingsResponse = await fetch(`${baseUrl}/api/v1/settings`, { headers });
  const settings = await settingsResponse.json();
  assert.equal(settingsResponse.status, 200);
  assert.equal(settings.providers.speech, 'deepgram');
  assert.equal(settings.security.secrets_exposed, false);
  assert.equal(settings.stores.some((store) => store.id === 'store-2'), false);

  const posResponse = await fetch(`${baseUrl}/api/v1/pos/transactions?store_id=store-1`, { headers });
  const pos = await posResponse.json();
  assert.equal(posResponse.status, 200);
  assert.equal(pos.transactions[0].product, 'USB-C Charger');
  assert.equal(pos.transactions[0].amount, 24.5);
});

test('Devcore task routes restrict access and validate task transitions', async () => {
  const adminHeaders = {
    Authorization: `Bearer ${createAccessToken(adminUser, secret)}`,
    'content-type': 'application/json',
  };
  const created = await fetch(`${baseUrl}/api/v1/devcore/tasks`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ title: 'Port API contracts', status: 'todo' }),
  });
  assert.equal(created.status, 201);
  const task = await created.json();
  assert.equal(task.project_id, 'proj-storelisten');

  const patched = await fetch(`${baseUrl}/api/v1/devcore/tasks/${task.id}`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ status: 'in_progress' }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).status, 'in_progress');

  const denied = await fetch(`${baseUrl}/api/v1/devcore/tasks`, {
    headers: { Authorization: `Bearer ${createAccessToken(user, secret)}` },
  });
  assert.equal(denied.status, 403);
});

test('speaker attribution is scoped and coaching uses only English transcript text', async () => {
  const conversationId = 'conversation-coaching-test';
  const segmentId = 'segment-coaching-test';
  conversations.push({
    id: conversationId,
    store_id: 'store-1',
    data_source: 'live',
    status: 'LIVE',
    started_at: new Date(),
  });
  transcriptSegments.push({
    id: segmentId,
    conversation_id: conversationId,
    speaker_id: 'speaker-unknown',
    language: 'es',
    original_text: 'Necesito un cargador.',
    translated_text: 'I need a charger.',
    start_time: 1,
    created_at: new Date(),
  });
  const headers = {
    Authorization: `****** secret)}`,
    'content-type': 'application/json',
  };
  headers.Authorization = `Bearer ${createAccessToken(user, secret)}`;
  const authenticationCheck = await fetch(`${baseUrl}/api/v1/stores`, { headers });
  assert.equal(authenticationCheck.status, 200, await authenticationCheck.text());
  const attribution = await fetch(`${baseUrl}/api/v1/conversations/${conversationId}/transcript/${segmentId}/speaker`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ speaker_role: 'customer' }),
  });
  assert.equal(attribution.status, 200);
  assert.equal((await attribution.json()).speaker_role, 'customer');
  assert.equal(transcriptSegments.find((segment) => segment.id === segmentId).speaker_id, 'speaker-customer');

  const coaching = await fetch(`${baseUrl}/api/v1/audio/coaching/${conversationId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  const coachingBody = await coaching.json();
  assert.equal(coaching.status, 200);
  assert.equal(coachingBody.conversation_id, conversationId);
  assert.equal(coachingBody.suggestion.message, 'Acknowledge the request and ask one concise clarifying question.');

  transcriptSegments.push({
    id: 'segment-untranslated-test',
    conversation_id: conversationId,
    speaker_id: 'speaker-unknown',
    language: 'es',
    original_text: 'Frase española sin traducción.',
    translated_text: null,
    start_time: 2,
    created_at: new Date(),
  });
  const analysis = await fetch(`${baseUrl}/api/v1/conversations/${conversationId}/analysis`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  assert.equal(analysis.status, 200);
  const analysisBody = await analysis.json();
  assert.equal(analysisBody.opportunities[0].product, 'phone charger');
  assert.equal(analysisBody.opportunities[0].status, 'REVIEW_REQUIRED');
  assert.match(analysisBody.caveat, /not proof/i);
  const report = await fetch(`${baseUrl}/api/v1/conversations/${conversationId}/report`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  assert.equal(report.status, 200);
  const reportBody = await report.json();
  assert.equal(reportBody.provider, 'rules');
  assert.match(JSON.stringify(reportBody), /phone charger/);
  assert.equal(JSON.stringify(reportBody).includes('Frase española sin traducción.'), false);

  const foreign = await fetch(`${baseUrl}/api/v1/conversations/foreign-conversation/transcript/${segmentId}/speaker`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ speaker_role: 'employee' }),
  });
  assert.equal(foreign.status, 404);
});

test('analytics is scoped and demo POS/replay data remains marked as non-live', async () => {
  const headers = { Authorization: `Bearer ${createAccessToken(user, secret)}` };
  const analytics = await fetch(`${baseUrl}/api/v1/analytics`, { headers });
  const analyticsBody = await analytics.json();
  assert.equal(analytics.status, 200);
  assert.equal(typeof analyticsBody.metrics.active_stores, 'number');
  assert.equal(Array.isArray(analyticsBody.stores), true);
  assert.equal(analyticsBody.store_performance.some((row) => row.store_id === 'store-1'), true);
  assert.equal(analyticsBody.store_performance.some((row) => row.store_id === 'store-2'), false);

  const demoDaily = await fetch(`${baseUrl}/api/v1/reports/daily`, { headers });
  assert.equal(demoDaily.status, 503);
  const demoWeekly = await fetch(`${baseUrl}/api/v1/reports/weekly`, { headers });
  const demoWeeklyBody = await demoWeekly.json();
  assert.equal(demoWeekly.status, 200);
  assert.equal(demoWeeklyBody.reportType, 'weekly');
  assert.equal(demoWeeklyBody.pos_provider, 'mock');

  const simulated = await fetch(`${baseUrl}/api/v1/pos/demo`, { method: 'POST', headers });
  const result = await simulated.json();
  assert.equal(simulated.status, 201);
  assert.equal(result.dataMode, 'demo');
  assert.equal(transactions.find((transaction) => transaction.id === result.transaction.id).provider, 'mock');
  assert.equal(transactionItems.some((item) => item.transaction_id === result.transaction.id && item.name === 'USB-C Charger'), true);

  const webhook = await fetch(`${baseUrl}/api/v1/pos/webhook`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ store_id: 'store-1', sku: 'SKU-1', name: 'Phone case', amount: 12.5 }),
  });
  const webhookResult = await webhook.json();
  assert.equal(webhook.status, 200);
  assert.equal(webhookResult.accepted, true);
  assert.equal(transactions.find((transaction) => transaction.id === webhookResult.transaction_id).provider, 'mock');

  const invalidWebhook = await fetch(`${baseUrl}/api/v1/pos/webhook`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ store_id: 'store-1', sku: 'SKU-1', name: 'Phone case', amount: 1_000_001 }),
  });
  assert.equal(invalidWebhook.status, 422);

  testConfig.demoMode = false;
  const previousPosProvider = testConfig.posProvider;
  try {
    testConfig.posProvider = 'none';
    const disconnectedWebhook = await fetch(`${baseUrl}/api/v1/pos/webhook`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ store_id: 'store-1', sku: 'SKU-1', name: 'Phone case', amount: 12.5 }),
    });
    assert.equal(disconnectedWebhook.status, 503);
    const rejected = await fetch(`${baseUrl}/api/v1/pos/demo`, { method: 'POST', headers });
    assert.equal(rejected.status, 409);
  } finally {
    testConfig.demoMode = true;
    testConfig.posProvider = previousPosProvider;
  }

  const replay = await fetch(`${baseUrl}/api/v1/demo/replay`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ store_id: 'store-1' }),
  });
  const replayResult = await replay.json();
  assert.equal(replay.status, 200);
  assert.equal(replayResult.status, 'started');
  assert.equal(replayResult.store_id, 'store-1');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const lastDemoConversation = conversations
    .filter((conversation) => conversation.data_source === 'demo' && conversation.store_id === 'store-1')
    .at(-1);
  assert.equal(lastDemoConversation?.status, 'ENDED');
  assert.equal(transcriptSegments.some((segment) => segment.conversation_id === lastDemoConversation?.id), true);
  assert.equal(publishedEvents.some(({ event }) => event.event === 'conversation.started' && event.conversationId === lastDemoConversation?.id), true);
});

test('daily reports use live evidence, persist provider output, and expose report history', async () => {
  testConfig.demoMode = false;
  const businessDate = '2025-03-12';
  const occurredAt = new Date(`${businessDate}T12:00:00.000Z`);
  conversations.push({
    id: 'conversation-daily-report-test',
    store_id: 'store-1',
    data_source: 'live',
    status: 'ENDED',
    started_at: occurredAt,
    ended_at: occurredAt,
    primary_language: 'en',
  });
  transcriptSegments.push({
    id: 'segment-daily-report-test',
    conversation_id: 'conversation-daily-report-test',
    speaker_id: 'speaker-customer',
    language: 'en',
    original_text: 'Do you have a phone charger?',
    translated_text: null,
    start_time: 1,
    created_at: occurredAt,
  });
  transactions.push({
    id: 'transaction-daily-report-test',
    store_id: 'store-1',
    amount: 19.99,
    currency: 'USD',
    occurred_at: occurredAt,
    provider: 'stripe',
  });
  const headers = {
    Authorization: `****** secret)}`,
    'content-type': 'application/json',
  };
  try {
    headers.Authorization = `Bearer ${createAccessToken(user, secret)}`;
    const generated = await fetch(`${baseUrl}/api/v1/reports/daily/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ store_id: 'store-1', business_date: businessDate }),
    });
    const payload = await generated.json();
    assert.equal(generated.status, 200);
    assert.equal(payload.dataMode, 'live');
    assert.equal(payload.daily_analysis.provider_summary.status, 'completed');
    assert.equal(payload.daily_analysis.provider_summary.provider, 'rules');
    assert.equal(payload.metrics.sales_count, 1);
    assert.equal(payload.store_listener.interactions[0].transcript_summary, 'Do you have a phone charger?');
    assert.equal(dailyReports.some((row) => row.id === `daily-store-1-${businessDate}`), true);

    const fetched = await fetch(`${baseUrl}/api/v1/reports/daily?store_id=store-1&business_date=${businessDate}`, { headers });
    assert.equal(fetched.status, 200);
    assert.equal((await fetched.json()).reportStatus, 'generated');

    const weekly = await fetch(`${baseUrl}/api/v1/reports/weekly?store_id=store-1&business_date=${businessDate}`, { headers });
    const monthly = await fetch(`${baseUrl}/api/v1/reports/monthly?store_id=store-1&business_date=${businessDate}`, { headers });
    const weeklyPayload = await weekly.json();
    const monthlyPayload = await monthly.json();
    assert.equal(weekly.status, 200);
    assert.equal(monthly.status, 200);
    assert.equal(weeklyPayload.reportType, 'weekly');
    assert.equal(monthlyPayload.reportType, 'monthly');
    assert.notEqual(weeklyPayload.range_start, monthlyPayload.range_start);

    const history = await fetch(`${baseUrl}/api/v1/reports/history?store_id=store-1`, { headers });
    const historyPayload = await history.json();
    assert.equal(history.status, 200);
    assert.equal(historyPayload.reports.some((row) => row.business_date === businessDate), true);
  } finally {
    testConfig.demoMode = true;
  }
});