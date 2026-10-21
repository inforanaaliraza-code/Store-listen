import http from 'node:http';
import mongoose from 'mongoose';
import { config } from './config.js';
import {
  AudioRecording,
  AudioSession,
  Alert,
  AiProcessingRun,
  AuditLog,
  ConversationParticipant,
  ConversationPosMatch,
  Conversation,
  CustomerIntent,
  DailyReport,
  DevcoreTask,
  Employee,
  EmployeePerformance,
  IntegrationConnection,
  MissedOpportunity,
  PosTransaction,
  PosTransactionItem,
  ProductOpportunity,
  SalesRecommendation,
  Store,
  StoreDevice,
  StockItem,
  StoreRule,
  TranscriptSegment,
  User,
} from './models.js';
import { createApp } from './app.js';
import { attachWebSockets } from './websocket.js';
import { createGridFsAudioStorage, createLocalAudioStorage } from './audio-storage.js';
import { cleanupExpiredRecordings, cleanupExpiredTranscripts } from './recording-cleanup.js';

if (!config.mongoUri) throw new Error('MONGODB_URI is required to start the Node backend.');

const eventHub = { publish: () => {} };

await mongoose.connect(config.mongoUri, {
  dbName: config.mongoDatabaseName,
  serverSelectionTimeoutMS: 10_000,
});

const audioStorage = config.storageProvider === 'gridfs'
  ? createGridFsAudioStorage(
    new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'audio_clips' }),
    mongoose.mongo.ObjectId,
  )
  : createLocalAudioStorage(config.audioStorageDir);

const app = createApp({
  config,
  mongoose,
  audioStorage,
  UserModel: User,
  StoreModel: Store,
  AuditLogModel: AuditLog,
  DeviceModel: StoreDevice,
  ConversationModel: Conversation,
  EmployeeModel: Employee,
  EmployeePerformanceModel: EmployeePerformance,
  DevcoreTaskModel: DevcoreTask,
  IntegrationConnectionModel: IntegrationConnection,
  CustomerIntentModel: CustomerIntent,
  MissedOpportunityModel: MissedOpportunity,
  ParticipantModel: ConversationParticipant,
  TranscriptSegmentModel: TranscriptSegment,
  AudioSessionModel: AudioSession,
  AudioRecordingModel: AudioRecording,
  StockItemModel: StockItem,
  StoreRuleModel: StoreRule,
  OpportunityModel: ProductOpportunity,
  SalesRecommendationModel: SalesRecommendation,
  AlertModel: Alert,
  AiProcessingRunModel: AiProcessingRun,
  DailyReportModel: DailyReport,
  PosTransactionModel: PosTransaction,
  PosTransactionItemModel: PosTransactionItem,
  PosMatchModel: ConversationPosMatch,
  sockets: eventHub,
});
const server = http.createServer(app);
const sockets = attachWebSockets(server, {
  jwtSecret: config.jwtSecret,
  UserModel: User,
  StoreModel: Store,
  DeviceModel: StoreDevice,
  ConversationModel: Conversation,
  TranscriptSegmentModel: TranscriptSegment,
  deepgramApiKey: config.deepgramApiKey,
  deeplApiKey: config.deeplApiKey,
  deeplApiUrl: config.deeplApiUrl,
  groqApiKey: config.groqApiKey,
  groqModel: config.groqModel,
});
eventHub.publish = sockets.publish;

let cleanupRunning = false;
async function cleanExpiredData() {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    const now = new Date();
    const [recordings, transcripts] = await Promise.all([
      cleanupExpiredRecordings({ AudioRecordingModel: AudioRecording }, audioStorage, now),
      cleanupExpiredTranscripts(TranscriptSegment, now, config.transcriptRetentionDays),
    ]);
    if (recordings || transcripts) {
      console.info(`Retention cleanup removed recordings=${recordings}, transcript_segments=${transcripts}`);
    }
  } catch (error) {
    console.error('Retention cleanup failed; expired data remains available for the next retry.', error);
  } finally {
    cleanupRunning = false;
  }
}

void cleanExpiredData();
const cleanupTimer = setInterval(() => void cleanExpiredData(), 15 * 60_000);
cleanupTimer.unref();

server.listen(config.port, config.host, () => {
  console.info(`Store Listen Node API listening on ${config.port}; db=${config.mongoDatabaseName}`);
});

async function shutdown(signal) {
  console.info(`Received ${signal}; shutting down Node API`);
  clearInterval(cleanupTimer);
  sockets.close();
  server.close(async () => {
    await mongoose.disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));