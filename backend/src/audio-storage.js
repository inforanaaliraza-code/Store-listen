import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const EXTENSIONS = new Map([
  ['audio/webm', '.webm'],
  ['audio/ogg', '.ogg'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/mp4', '.m4a'],
  ['audio/mpeg', '.mp3'],
]);

function audioExtension(contentType) {
  const extension = EXTENSIONS.get(String(contentType).split(';')[0].toLowerCase());
  if (!extension) throw new Error('Unsupported audio format.');
  return extension;
}

function audioDate(capturedAt) {
  const date = new Date(capturedAt);
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid recording timestamp.');
  return date;
}

export async function saveAudioClip(bytes, contentType, capturedAt, rootDirectory) {
  const extension = audioExtension(contentType);
  const date = audioDate(capturedAt);
  const key = path.posix.join(
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
    `${randomUUID()}${extension}`,
  );
  const absolutePath = path.resolve(rootDirectory, ...key.split('/'));
  if (!absolutePath.startsWith(`${path.resolve(rootDirectory)}${path.sep}`)) throw new Error('Invalid audio storage path.');
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes, { flag: 'wx' });
  return key;
}

export function resolveAudioClip(storageKey, rootDirectory) {
  const normalized = String(storageKey || '').replaceAll('\\', '/');
  if (!normalized || normalized.split('/').includes('..') || path.posix.isAbsolute(normalized)) {
    throw new Error('Invalid audio storage key.');
  }
  const absolutePath = path.resolve(rootDirectory, ...normalized.split('/'));
  if (!absolutePath.startsWith(`${path.resolve(rootDirectory)}${path.sep}`)) throw new Error('Invalid audio storage path.');
  return absolutePath;
}

export async function readAudioClip(storageKey, rootDirectory) {
  return readFile(resolveAudioClip(storageKey, rootDirectory));
}

export async function deleteAudioClip(storageKey, rootDirectory) {
  await unlink(resolveAudioClip(storageKey, rootDirectory));
}

export function createLocalAudioStorage(rootDirectory) {
  return {
    save: (bytes, contentType, capturedAt) => saveAudioClip(bytes, contentType, capturedAt, rootDirectory),
    read: (storageKey) => readAudioClip(storageKey, rootDirectory),
    delete: (storageKey) => deleteAudioClip(storageKey, rootDirectory),
  };
}

export function createGridFsAudioStorage(bucket, ObjectId) {
  function objectId(storageKey) {
    if (typeof storageKey !== 'string' || !/^[a-f\d]{24}$/i.test(storageKey)) {
      const error = new Error('Invalid GridFS audio storage key; no GridFS file exists for this reference.');
      error.code = 'ENOENT';
      throw error;
    }
    return new ObjectId(storageKey);
  }

  return {
    async save(bytes, contentType, capturedAt) {
      const extension = audioExtension(contentType);
      const date = audioDate(capturedAt);
      const filename = `${date.toISOString().slice(0, 10)}/${randomUUID()}${extension}`;
      const stream = bucket.openUploadStream(filename, {
        metadata: {
          contentType: String(contentType).split(';')[0].toLowerCase(),
          capturedAt: date,
        },
      });
      const completed = new Promise((resolve, reject) => {
        stream.once('error', reject);
        stream.once('finish', () => resolve(stream.id.toString()));
      });
      stream.end(bytes);
      return completed;
    },

    async read(storageKey) {
      const stream = bucket.openDownloadStream(objectId(storageKey));
      const chunks = [];
      return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.once('error', reject);
        stream.once('end', () => resolve(Buffer.concat(chunks)));
      });
    },

    async delete(storageKey) {
      const id = objectId(storageKey);
      if (!await bucket.find({ _id: id }).hasNext()) {
        const error = new Error('Audio clip does not exist in GridFS.');
        error.code = 'ENOENT';
        throw error;
      }
      await bucket.delete(id);
    },
  };
}