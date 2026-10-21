import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanupExpiredRecordings,
  cleanupExpiredTranscripts,
  deleteOrphanRecordings,
} from '../src/recording-cleanup.js';

function queryResult(rows) {
  return {
    sort() { return this; },
    limit() { return this; },
    select() { return this; },
    lean: async () => rows,
  };
}

test('expired GridFS recordings are removed from storage before metadata deletion', async () => {
  const removedKeys = [];
  let deletedIds;
  const models = {
    AudioRecordingModel: {
      find(filter) {
        assert.equal(filter.retain_until.$lte instanceof Date, true);
        return queryResult([{ id: 'audio-expired', storage_key: '0123456789abcdef01234567' }]);
      },
      deleteMany: async (filter) => {
        deletedIds = filter.id.$in;
        return { deletedCount: deletedIds.length };
      },
    },
  };
  const count = await cleanupExpiredRecordings(models, {
    delete: async (key) => removedKeys.push(key),
  }, new Date('2026-10-21T00:00:00.000Z'));

  assert.equal(count, 1);
  assert.deepEqual(removedKeys, ['0123456789abcdef01234567']);
  assert.deepEqual(deletedIds, ['audio-expired']);
});

test('transcript retention deletes only segments older than the configured cutoff', async () => {
  let filter;
  const model = {
    find(value) {
      filter = value;
      return queryResult([{ id: 'segment-expired' }]);
    },
    deleteMany: async (value) => ({ deletedCount: value.id.$in.length }),
  };
  const count = await cleanupExpiredTranscripts(model, new Date('2026-10-21T00:00:00.000Z'), 30);

  assert.equal(count, 1);
  assert.equal(filter.created_at.$lte.toISOString(), '2026-09-21T00:00:00.000Z');
});

test('bulk cleanup removes metadata with absent or legacy GridFS audio references', async () => {
  let deletedIds;
  const models = {
    AudioRecordingModel: {
      deleteMany: async (filter) => {
        deletedIds = filter.id.$in;
        return { deletedCount: deletedIds.length };
      },
    },
  };
  const audioStorage = {
    delete: async (key) => {
      assert.equal(key, 'legacy-local-path.webm');
      const error = new Error('GridFS audio file does not exist.');
      error.code = 'ENOENT';
      throw error;
    },
  };
  const deleted = await deleteOrphanRecordings([
    { id: 'audio-legacy', storage_key: 'legacy-local-path.webm' },
    { id: 'audio-metadata-only' },
  ], models, audioStorage);

  assert.equal(deleted, 2);
  assert.deepEqual(deletedIds, ['audio-legacy', 'audio-metadata-only']);
});
