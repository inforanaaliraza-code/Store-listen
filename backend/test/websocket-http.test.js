import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createAccessToken, hashDeviceSecret } from '../src/auth.js';
import { attachWebSockets } from '../src/websocket.js';

const jwtSecret = 'test-websocket-jwt-secret-with-sufficient-length';
const deviceSecret = 'test-device-secret-for-websocket';

function createMessageReader(socket) {
  const queued = [];
  const waiting = [];
  socket.on('message', (message) => {
    const event = JSON.parse(message.toString());
    const resolve = waiting.shift();
    if (resolve) resolve(event);
    else queued.push(event);
  });
  return () => {
    if (queued.length) return Promise.resolve(queued.shift());
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = waiting.indexOf(onMessage);
        if (index >= 0) waiting.splice(index, 1);
        reject(new Error('Timed out waiting for WebSocket message'));
      }, 2000);
      const onMessage = (event) => {
        clearTimeout(timeout);
        resolve(event);
      };
      waiting.push(onMessage);
    });
  };
}

test('HTTP WebSocket upgrades authenticate store/device sockets and publish health and close events', async () => {
  const updates = [];
  const device = {
    id: 'device-websocket-test',
    store_id: 'store-websocket-test',
    status: 'registered',
    secret_hash: hashDeviceSecret(deviceSecret),
    revoked: false,
  };
  const user = {
    id: 'user-websocket-test',
    organization_id: 'org-websocket-test',
    role: 'STORE_MANAGER',
    store_id: device.store_id,
    is_active: true,
  };
  const server = http.createServer();
  const sockets = attachWebSockets(server, {
    jwtSecret,
    UserModel: {
      findOne: (filter) => ({ lean: async () => filter.id === user.id ? { ...user } : null }),
    },
    StoreModel: {
      findOne: (filter) => ({
        lean: async () => filter.id === device.store_id && filter.organization_id === user.organization_id
          ? { id: device.store_id, organization_id: user.organization_id }
          : null,
      }),
    },
    DeviceModel: {
      findOne: (filter) => ({ lean: async () => filter.id === device.id ? { ...device } : null }),
      updateOne: async (filter, update) => {
        if (filter.id === device.id) {
          Object.assign(device, update.$set);
          updates.push({ ...update.$set });
        }
      },
    },
    ConversationModel: {},
    TranscriptSegmentModel: {},
    deepgramApiKey: '',
    deeplApiKey: '',
    deeplApiUrl: 'https://api-free.deepl.com',
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `ws://127.0.0.1:${address.port}`;
  const authProtocol = (token) => ['storelisten.v1', token];
  let storeSocket;
  let deviceSocket;
  try {
    storeSocket = new WebSocket(`${baseUrl}/ws/stores/${device.store_id}`, authProtocol(createAccessToken(user, jwtSecret)));
    await once(storeSocket, 'open');
    const readStoreMessage = createMessageReader(storeSocket);
    deviceSocket = new WebSocket(`${baseUrl}/ws/device/${device.id}`, authProtocol(deviceSecret));
    await once(deviceSocket, 'open');

    const healthEvent = readStoreMessage();
    deviceSocket.send(JSON.stringify({
      cpu_pct: 22,
      memory_pct: 31,
      audio_status: 'streaming',
      microphone_status: 'ok',
      stream_status: 'active',
      processing_latency_ms: 170,
      speaking: true,
    }));
    const health = await healthEvent;
    assert.equal(health.event, 'device.health.updated');
    assert.equal(health.deviceId, device.id);
    assert.equal(health.storeId, device.store_id);
    assert.equal(device.cpu_pct, 22);
    assert.equal(device.speaking, true);
    assert.equal(updates.some((update) => update.status === 'connected'), true);

    deviceSocket.close(1000);
    const healthDisconnected = await readStoreMessage();
    const disconnected = await readStoreMessage();
    assert.equal(healthDisconnected.event, 'device.health.updated');
    assert.equal(healthDisconnected.status, 'disconnected');
    assert.equal(disconnected.event, 'device.disconnected');
    assert.equal(device.status, 'disconnected');
    assert.equal(device.stream_status, 'idle');
  } finally {
    if (deviceSocket && deviceSocket.readyState !== WebSocket.CLOSED) deviceSocket.close();
    if (storeSocket && storeSocket.readyState !== WebSocket.CLOSED) storeSocket.close();
    sockets.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
