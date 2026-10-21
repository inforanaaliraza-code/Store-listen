import { WebSocketServer } from 'ws';
import { readToken, verifyDeviceSecret } from './auth.js';
import { attachDeviceAudioSocket } from './audio-websocket.js';

const AUTH_PROTOCOL = 'storelisten.v1';

function tokenFromUpgrade(request, protocols) {
  const authorization = request.headers.authorization || '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return bearer;
  const parts = protocols.split(',').map((part) => part.trim());
  if (parts.length === 2 && parts[0] === AUTH_PROTOCOL) return parts[1];
  return new URL(request.url, 'http://localhost').searchParams.get('token') || '';
}

export function attachWebSockets(server, {
  jwtSecret,
  UserModel,
  StoreModel,
  DeviceModel,
  ConversationModel,
  TranscriptSegmentModel,
  deepgramApiKey,
  deeplApiKey,
  deeplApiUrl,
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const rooms = new Map();
  const publish = (room, event) => {
    const payload = JSON.stringify(event);
    for (const client of rooms.get(room) || []) {
      if (client.readyState === 1) client.send(payload);
    }
  };

  server.on('upgrade', async (request, socket, head) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const pathname = url.pathname;
      const protocols = request.headers['sec-websocket-protocol'] || '';
      const audioMatch = pathname.match(/^\/ws\/audio\/([^/]+)\/([^/]+)$/);
      const deviceMatch = pathname.match(/^\/ws\/device\/([^/]+)$/);

      if (audioMatch || deviceMatch) {
        const deviceId = decodeURIComponent(audioMatch?.[1] || deviceMatch[1]);
        const token = tokenFromUpgrade(request, protocols);
        const device = await DeviceModel?.findOne({ id: deviceId }).lean();
        if (!device || device.revoked || !verifyDeviceSecret(token, device.secret_hash)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          return socket.destroy();
        }
        if (deviceMatch) {
          wss.handleUpgrade(request, socket, head, (client) => {
            client.on('message', async (message, isBinary) => {
              if (isBinary) return;
              const raw = String(message);
              if (raw === 'ping' || raw === 'keepalive') return client.send('pong');
              let health;
              try { health = JSON.parse(raw); } catch { return; }
              const now = new Date();
              const fields = {
                status: 'connected',
                last_heartbeat: now,
                cpu_pct: Number(health.cpu_pct) || 0,
                memory_pct: Number(health.memory_pct) || 0,
                audio_status: health.audio_status || 'idle',
                microphone_status: health.microphone_status || 'disconnected',
                stream_status: health.stream_status || 'idle',
                processing_latency_ms: Number(health.processing_latency_ms) || 0,
              };
              if (typeof health.speaking === 'boolean') fields.speaking = health.speaking;
              await DeviceModel.updateOne({ id: device.id }, { $set: fields });
              publish(`store:${device.store_id}`, {
                event: 'device.health.updated',
                deviceId: device.id,
                storeId: device.store_id,
                ...fields,
                timestamp: now.toISOString(),
              });
            });
            client.on('close', () => {
              const now = new Date();
              const fields = { status: 'disconnected', audio_status: 'idle', stream_status: 'idle', last_heartbeat: now };
              void DeviceModel.updateOne({ id: device.id }, { $set: fields })
                .catch((error) => console.error(`Failed to mark device ${device.id} disconnected:`, error));
              publish(`store:${device.store_id}`, {
                event: 'device.health.updated',
                deviceId: device.id,
                storeId: device.store_id,
                ...fields,
                timestamp: now.toISOString(),
              });
              publish(`store:${device.store_id}`, { event: 'device.disconnected', deviceId: device.id, storeId: device.store_id, timestamp: now.toISOString() });
            });
          });
          return;
        }

        const approvedStatus = device.approval_status || (device.status === 'registered' ? 'approved' : 'pending');
        if (approvedStatus !== 'approved') {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          return socket.destroy();
        }
        if (!deepgramApiKey) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
          return socket.destroy();
        }
        const conversationId = decodeURIComponent(audioMatch[2]);
        const conversation = await ConversationModel?.findOne({
          id: conversationId,
          store_id: device.store_id,
          status: 'LIVE',
        }).lean();
        if (!conversation) {
          socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
          return socket.destroy();
        }
        const sampleRate = Number.parseInt(url.searchParams.get('sample_rate') || '', 10);
        if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) {
          socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
          return socket.destroy();
        }

        wss.handleUpgrade(request, socket, head, (client) => {
          void attachDeviceAudioSocket(client, {
            device,
            conversation,
            sampleRate,
            deepgramApiKey,
            deeplApiKey,
            deeplApiUrl,
            ConversationModel,
            TranscriptSegmentModel,
            publish,
          }).catch(() => client.close(1011, 'Live transcription could not start'));
        });
        return;
      }

      const match = pathname.match(/^\/ws\/(dashboard|stores\/([^/]+))$/);
      if (!match) return socket.destroy();

      const token = tokenFromUpgrade(request, protocols);
      if (!token) return socket.destroy();
      const claims = readToken(token, jwtSecret);
      const user = await UserModel.findOne({ id: claims.sub, is_active: { $ne: false } }).lean();
      if (!user) return socket.destroy();

      const room = match[1] === 'dashboard' ? 'dashboard' : `store:${decodeURIComponent(match[2])}`;
      if (room === 'dashboard' && !['SUPER_ADMIN', 'ORG_ADMIN'].includes(user.role)) return socket.destroy();
      if (room.startsWith('store:')) {
        const storeId = room.slice('store:'.length);
        const store = await StoreModel.findOne({ id: storeId, organization_id: user.organization_id }).lean();
        if (!store && user.role !== 'SUPER_ADMIN') return socket.destroy();
      }

      wss.handleUpgrade(request, socket, head, (client) => {
        client.room = room;
        const members = rooms.get(room) || new Set();
        members.add(client);
        rooms.set(room, members);
        client.on('message', (message) => {
          if (String(message) === 'ping' || String(message) === 'keepalive') client.send('pong');
        });
        client.on('close', () => {
          members.delete(client);
          if (!members.size) rooms.delete(room);
        });
      });
    } catch {
      socket.destroy();
    }
  });

  return {
    wss,
    publish,
    close() {
      for (const client of wss.clients) client.close(1001, 'Server shutting down');
      wss.close();
    },
  };
}