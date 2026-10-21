const test = require('node:test');
const assert = require('node:assert/strict');
const { createAudioSocket, floatToPcm16 } = require('../src/live-audio');

test('converts Float32 audio into signed 16-bit PCM', () => {
  assert.deepEqual([...floatToPcm16(new Float32Array([-1, -0.5, 0, 0.5, 1]))], [-32768, -16384, 0, 16384, 32767]);
});

test('creates authenticated audio websocket with the exact microphone sample rate', async () => {
  let socketUrl;
  let socketProtocols;
  let fakeSocket;
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 0;
    handlers = {};
    constructor(url, protocols) { socketUrl = url; socketProtocols = protocols; fakeSocket = this; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    close() { this.readyState = 3; }
  }

  const promise = createAudioSocket({
    apiBase: 'https://api.example.com',
    deviceId: 'device 1',
    deviceSecret: 'device-secret',
    conversationId: 'conv 1',
    sampleRate: 48000,
    WebSocketClass: FakeWebSocket,
  });
  const socket = fakeSocket;
  socket.readyState = FakeWebSocket.OPEN;
  socket.handlers.open();
  assert.equal(await promise, socket);
  assert.equal(socketUrl, 'wss://api.example.com/ws/audio/device%201/conv%201?sample_rate=48000');
  assert.deepEqual(socketProtocols, ['storelisten.v1', 'device-secret']);
});