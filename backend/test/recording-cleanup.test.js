import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupExpiredRecordings, cleanupExpiredTranscripts } from '../src/recording-cleanup.js';

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
