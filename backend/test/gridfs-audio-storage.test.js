import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createGridFsAudioStorage } from '../src/audio-storage.js';

class UploadStream extends EventEmitter {
  constructor(id, files) {
    super();
    this.id = id;
    this.files = files;
  }

  end(buffer) {
    this.files.set(this.id, Buffer.from(buffer));
    queueMicrotask(() => this.emit('finish'));
  }
}

test('GridFS audio adapter saves, reads, and deletes clips by validated object id', async () => {
  const files = new Map();
  const bucket = {
    openUploadStream: (_name, options) => {
      assert.equal(options.metadata.contentType, 'audio/webm');
      assert.equal(options.metadata.capturedAt instanceof Date, true);
      const id = '0123456789abcdef01234567';
      return new UploadStream(id, files);
    },
    openDownloadStream: (id) => Readable.from([files.get(id.toString())]),
    find: ({ _id }) => ({ hasNext: async () => files.has(_id.toString()) }),
    delete: async (id) => { files.delete(id.toString()); },
  };
  class FakeObjectId {
    constructor(value) { this.value = value; }
    toString() { return this.value; }
  }
  const storage = createGridFsAudioStorage(bucket, FakeObjectId);
  const clip = Buffer.from([1, 2, 3, 4]);
  const key = await storage.save(clip, 'audio/webm; codecs=opus', new Date('2026-10-21T00:00:00.000Z'));

  assert.equal(key, '0123456789abcdef01234567');
  assert.deepEqual(await storage.read(key), clip);
  await storage.delete(key);
  assert.equal(files.has(key), false);
  await assert.rejects(storage.delete(key), { code: 'ENOENT' });
  await assert.rejects(storage.read('not-an-object-id'), /Invalid GridFS audio storage key/);
  await assert.rejects(storage.delete('legacy-local-path.webm'), { code: 'ENOENT' });
});
