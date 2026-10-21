import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDirectory = path.dirname(fileURLToPath(import.meta.url));
for (const envPath of [path.resolve(backendDirectory, '../.env'), path.resolve(backendDirectory, '../../.env')]) {
  if (existsSync(envPath)) dotenv.config({ path: envPath, override: false });
}

const numberFromEnv = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const appEnv = process.env.APP_ENV || 'development';
const productionDemoModeRequested = appEnv === 'production' && process.env.DEMO_MODE === 'true';
if (productionDemoModeRequested) {
  console.warn('DEMO_MODE=true is ignored in production; live-only mode is enforced.');
}

const deepgramApiKey = String(process.env.DEEPGRAM_API_KEY || '').trim();
if (/[^\x20-\x7e]/.test(deepgramApiKey)) {
  throw new Error('DEEPGRAM_API_KEY contains invalid characters. Re-enter the key without line breaks.');
}
const groqApiKey = String(process.env.GROQ_API_KEY || '').trim();
if (/[^\x20-\x7e]/.test(groqApiKey)) {
  throw new Error('GROQ_API_KEY contains invalid characters. Re-enter it without line breaks.');
}
const deeplApiKey = String(process.env.DEEPL_API_KEY || '').trim();
if (/[^\x20-\x7e]/.test(deeplApiKey)) {
  throw new Error('DEEPL_API_KEY contains invalid characters. Re-enter it without line breaks.');
}
const requestedGroqModel = String(process.env.GROQ_MODEL || '').trim();
const deprecatedGroqModels = new Map([
  ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
]);
const groqModel = deprecatedGroqModels.get(requestedGroqModel) || requestedGroqModel || 'openai/gpt-oss-120b';
if (deprecatedGroqModels.has(requestedGroqModel)) {
  console.warn(`GROQ_MODEL=${requestedGroqModel} is retired; using ${groqModel}.`);
}
if (groqModel.length > 100 || /[\r\n]/.test(groqModel)) {
  throw new Error('GROQ_MODEL must be a model name no longer than 100 characters.');
}

export const config = Object.freeze({
  appEnv,
  host: process.env.HOST || '127.0.0.1',
  port: numberFromEnv('PORT', 8000),
  mongoUri: process.env.MONGODB_URI || '',
  mongoDatabaseName: process.env.MONGO_DATABASE_NAME || 'storelisten',
  demoMode: appEnv === 'production' ? false : process.env.DEMO_MODE === 'true',
  aiProvider: 'rules',
  groqApiKey,
  groqModel,
  speechProvider: 'deepgram',
  posProvider: process.env.POS_PROVIDER || 'none',
  storageProvider: process.env.STORAGE_PROVIDER || 'local',
  jwtSecret: process.env.JWT_SECRET || 'local-development-only-change-before-deploy',
  deepgramApiKey,
  deeplApiKey,
  deeplApiUrl: (process.env.DEEPL_API_URL || 'https://api-free.deepl.com').replace(/\/+$/, ''),
  audioStorageDir: path.resolve(process.env.AUDIO_STORAGE_DIR || './storage/audio'),
  audioRetentionDays: numberFromEnv('AUDIO_RETENTION_DAYS', 7),
  transcriptRetentionDays: numberFromEnv('TRANSCRIPT_RETENTION_DAYS', 30),
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  corsOriginRegex: process.env.CORS_ORIGIN_REGEX || '^https://.*\\.ts\\.net$',
});

if (!['gridfs', 'local'].includes(config.storageProvider)) {
  throw new Error('STORAGE_PROVIDER must be either "gridfs" or "local".');
}
if (config.appEnv === 'production' && config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production.');
}
if (config.appEnv === 'production' && (!process.env.JWT_SECRET || config.jwtSecret === 'local-development-only-change-before-deploy')) {
  throw new Error('Set a unique JWT_SECRET before starting the backend in production.');
}
if (config.appEnv === 'production' && config.storageProvider !== 'gridfs') {
  throw new Error('STORAGE_PROVIDER=gridfs is required in production for durable audio storage.');
}
if (config.appEnv === 'production' && config.posProvider === 'mock') {
  throw new Error('POS_PROVIDER=mock is not allowed in production. Configure a live POS integration or use none.');
}
if (config.appEnv === 'production' && !config.deepgramApiKey) {
  throw new Error('DEEPGRAM_API_KEY is required in production.');
}