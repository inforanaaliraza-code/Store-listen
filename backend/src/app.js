import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { createAccessToken, readToken, requireAuth, tokenFromRequest, verifyDeviceSecret, verifyPassword } from './auth.js';
import { createLocalAudioStorage } from './audio-storage.js';
import { addCleanupCounts, deleteConversationAudio, deleteOrphanRecordings, emptyCounts } from './recording-cleanup.js';
import { transcribeWithDeepgram } from './deepgram-transcribe.js';
import { isSpanishTranscript, translateToEnglish } from './translation.js';
import { analyzeConversation } from './rule-analysis.js';
import {
  generateGroqCoaching,
  generateGroqConversationReport,
  generateGroqDailySummary,
} from './groq-ai.js';

export function createApp({
  config,
  mongoose,
  UserModel,
  StoreModel,
  AuditLogModel,
  DeviceModel,
  ConversationModel,
  EmployeeModel,
  EmployeePerformanceModel,
  IntegrationConnectionModel,
  DevcoreTaskModel,
  ParticipantModel,
  TranscriptSegmentModel,
  AudioSessionModel,
  AudioRecordingModel,
  StockItemModel,
  StoreRuleModel,
  OpportunityModel,
  CustomerIntentModel,
  MissedOpportunityModel,
  SalesRecommendationModel,
  AlertModel,
  AiProcessingRunModel,
  PosTransactionModel,
  PosTransactionItemModel,
  PosMatchModel,
  DailyReportModel,
  sockets,
  audioStorage: suppliedAudioStorage,
  deepgramTranscriber = transcribeWithDeepgram,
  englishTranslator = translateToEnglish,
  groqCoaching = generateGroqCoaching,
  groqConversationReport = generateGroqConversationReport,
  groqDailySummary = generateGroqDailySummary,
}) {
  const audioStorage = suppliedAudioStorage || createLocalAudioStorage(config.audioStorageDir);
  const app = express();
  const translationJobs = new Map();
  const failedTranslationRetryAt = new Map();
  app.set('trust proxy', config.appEnv === 'production' ? 1 : false);
  app.use(helmet());
  app.use(cors({
    credentials: true,
    maxAge: 600,
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
      try {
        if (new RegExp(config.corsOriginRegex).test(origin)) return callback(null, true);
      } catch { /* Invalid optional origin pattern: rely on explicit origins. */ }
      return callback(null, false);
    },
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use((request, response, next) => {
    request.id = request.get('x-request-id')?.slice(0, 128) || randomUUID();
    response.set('X-Request-ID', request.id);
    next();
  });

  app.get('/health', (_request, response) => response.json({ status: 'ok' }));
  app.get('/ready', (_request, response) => {
    const ready = mongoose.connection.readyState === 1;
    response.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      mode: config.demoMode ? 'demo' : 'live',
      database: ready ? 'connected' : 'disconnected',
      providers: {
        groq_model: config.groqModel,
      },
      capabilities: {
        transcription: config.deepgramApiKey ? 'available' : 'unavailable',
        english_translation: config.deeplApiKey || config.groqApiKey ? 'available' : 'unavailable',
        live_coaching: config.groqApiKey ? 'available' : 'unavailable',
        daily_reports: config.groqApiKey ? 'available' : 'unavailable',
      },
    });
  });
  app.get('/metrics', (_request, response) => response.json({ requests_total: 0, demo_mode: config.demoMode }));

  const loginLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
  const coachingLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  app.post('/api/v1/auth/login', loginLimiter, async (request, response, next) => {
    try {
      const email = String(request.body?.email || '').trim().toLowerCase();
      const password = String(request.body?.password || '');
      if (!email || !password) return response.status(422).json({ detail: 'Email and password are required' });
      const user = await UserModel.findOne({ email }).lean();
      if (!user || user.is_active === false || !verifyPassword(password, user.password_hash)) {
        return response.status(401).json({ detail: 'Invalid email or password' });
      }
      const token = createAccessToken(user, config.jwtSecret);
      response.cookie('sl_session', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.appEnv === 'production',
        maxAge: 12 * 60 * 60 * 1000,
      });
      if (AuditLogModel) {
        await AuditLogModel.create({
          id: `aud-${randomUUID().replaceAll('-', '').slice(0, 10)}`,
          actor_id: user.id,
          action: 'login',
          entity: 'user',
          entity_id: user.id,
          created_at: new Date(),
        });
      }
      return response.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          full_name: user.full_name,
          role: user.role,
          store_id: user.store_id ?? null,
          organization_id: user.organization_id,
        },
      });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/auth/logout', (_request, response) => {
    response.clearCookie('sl_session', { httpOnly: true, sameSite: 'lax', secure: config.appEnv === 'production' });
    return response.json({ status: 'signed_out' });
  });

  const authenticate = requireAuth({ UserModel, jwtSecret: config.jwtSecret });
  const audioActor = async (request, response, next) => {
    try {
      const token = tokenFromRequest(request);
      if (!token) return response.status(401).json({ detail: 'Authentication required' });
      const deviceId = request.get('x-device-id');
      if (deviceId) {
        const device = await DeviceModel?.findOne({ id: deviceId }).lean();
        if (!device || device.revoked || !verifyDeviceSecret(token, device.secret_hash)) {
          return response.status(401).json({ detail: 'Invalid or expired device session' });
        }
        request.audioActor = { device };
      } else {
        const claims = readToken(token, config.jwtSecret);
        const user = await UserModel.findOne({ id: claims.sub, is_active: { $ne: false } }).lean();
        if (!user) return response.status(401).json({ detail: 'Account is inactive' });
        request.audioActor = { user };
      }
      return next();
    } catch {
      return response.status(401).json({ detail: 'Invalid or expired session' });
    }
  };
  const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

  async function accessibleStore(storeId, actor) {
    const store = await StoreModel.findOne({ id: storeId }).lean();
    if (!store) return null;
    if (actor.device) return actor.device.store_id === store.id ? store : null;
    if (actor.user.role === 'SUPER_ADMIN') return store;
    if (store.organization_id !== actor.user.organization_id) return null;
    if (actor.user.role === 'STORE_MANAGER' && actor.user.store_id !== store.id) return null;
    return store;
  }

  async function visibleStoreIds(user) {
    if (user.role === 'SUPER_ADMIN') return null;
    if (user.store_id) return [user.store_id];
    if (user.role !== 'ORG_ADMIN') return [];
    return (await StoreModel.find({ organization_id: user.organization_id }).select({ id: 1 }).lean()).map((store) => store.id);
  }

  async function scopedStoreFilter(user, field = 'store_id') {
    const ids = await visibleStoreIds(user);
    return ids === null ? {} : { [field]: { $in: ids } };
  }

  function fail(status, message) {
    const error = new Error(message);
    error.status = status;
    throw error;
  }

  function requireStoreManager(user) {
    if (!['SUPER_ADMIN', 'ORG_ADMIN', 'STORE_MANAGER'].includes(user.role)) {
      fail(403, 'Store management access required');
    }
  }

  function requireOrganizationAdmin(user) {
    if (!['SUPER_ADMIN', 'ORG_ADMIN'].includes(user.role)) {
      fail(403, 'Organization administrator access required');
    }
  }

  function requiredText(body, field, maxLength) {
    const value = typeof body?.[field] === 'string' ? body[field].trim() : '';
    if (!value || value.length > maxLength) fail(422, `${field} must contain 1-${maxLength} characters`);
    return value;
  }

  function optionalText(body, field, maxLength) {
    const value = body?.[field];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
      fail(422, `${field} must contain 1-${maxLength} characters`);
    }
    return value.trim();
  }

  function numericValue(body, field, { integer = false, optional = false } = {}) {
    const value = body?.[field];
    if (optional && value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > (integer ? 10_000_000 : 1_000_000) || (integer && !Number.isInteger(value))) {
      fail(422, `${field} is outside the allowed range`);
    }
    return value;
  }

  async function writeAudit(user, action, entity, entityId, detail = '') {
    if (!AuditLogModel) return;
    await AuditLogModel.create({
      id: `aud-${randomUUID().replaceAll('-', '').slice(0, 10)}`,
      actor_id: user.id,
      action,
      entity,
      entity_id: entityId,
      detail,
      created_at: new Date(),
    });
  }

  function serializeStockItem(item) {
    return {
      id: item.id,
      store_id: item.store_id,
      sku: item.sku,
      name: item.name,
      cost: item.cost,
      price: item.price,
      quantity: item.quantity,
      par_level: item.par_level,
    };
  }

  function serializeStoreRule(rule) {
    return {
      id: rule.id,
      store_id: rule.store_id,
      name: rule.name,
      dollar_value: rule.dollar_value,
      trigger_condition: rule.trigger_condition,
      expected_action: rule.expected_action,
      active: rule.active,
    };
  }

  async function hasStoreReferences(storeId) {
    const models = [
      DeviceModel, ConversationModel, EmployeeModel, StockItemModel, StoreRuleModel,
      AudioRecordingModel, OpportunityModel, PosTransactionModel,
    ].filter(Boolean);
    const counts = await Promise.all(models.map((model) => model.countDocuments({ store_id: storeId })));
    return counts.some((count) => count > 0);
  }

  function recordingCleanupModels() {
    return {
      ConversationModel,
      AudioRecordingModel,
      TranscriptSegmentModel,
      ParticipantModel,
      AiProcessingRunModel,
      CustomerIntentModel,
      OpportunityModel,
      SalesRecommendationModel,
      MissedOpportunityModel,
      PosMatchModel,
      AudioSessionModel,
    };
  }

  function requireRecordingManager(user) {
    if (!['SUPER_ADMIN', 'ORG_ADMIN', 'STORE_MANAGER'].includes(user.role)) {
      fail(403, 'Recording management access required');
    }
  }

  async function toEnglishTranscript(transcript, language) {
    const normalizedLanguage = String(language || '').toLowerCase();
    const needsTranslation = isSpanishTranscript(transcript, normalizedLanguage);
    if (!needsTranslation) return { englishText: transcript, translatedText: null, translationStatus: 'not_needed' };
    try {
      const translatedText = await englishTranslator(transcript, {
        apiKey: config.deeplApiKey,
        apiUrl: config.deeplApiUrl,
        groqApiKey: config.groqApiKey,
        groqModel: config.groqModel,
        signal: AbortSignal.timeout(6000),
      });
      return { englishText: translatedText, translatedText, translationStatus: 'translated' };
    } catch (error) {
      console.warn(`Transcript translation pending; provider request failed: ${error?.message || 'unknown error'}`);
      return {
        englishText: 'English translation unavailable',
        translatedText: null,
        translationStatus: 'unavailable',
      };
    }
  }

  async function repairMissingTranslations(segments) {
    if (!config.deeplApiKey && !config.groqApiKey) return;
    const pending = segments.filter((segment) => (
      !segment.translated_text
      && segment.is_final !== false
      && isSpanishTranscript(segment.original_text, segment.language)
      && (failedTranslationRetryAt.get(segment.id) || 0) <= Date.now()
    )).slice(0, 5);

    for (let index = 0; index < pending.length; index += 3) {
      await Promise.all(pending.slice(index, index + 3).map(async (segment) => {
        let job = translationJobs.get(segment.id);
        if (!job) {
          job = (async () => {
            const translated = await toEnglishTranscript(segment.original_text, segment.language);
            if (!translated.translatedText) {
              failedTranslationRetryAt.set(segment.id, Date.now() + 60_000);
              if (failedTranslationRetryAt.size > 1000) {
                failedTranslationRetryAt.delete(failedTranslationRetryAt.keys().next().value);
              }
              return null;
            }
            await TranscriptSegmentModel.updateOne(
              { id: segment.id, conversation_id: segment.conversation_id },
              { $set: { translated_text: translated.translatedText } },
            );
            failedTranslationRetryAt.delete(segment.id);
            return translated.translatedText;
          })().catch((error) => {
            console.error(`Could not repair saved transcript translation segment=${segment.id}`, error);
            return null;
          });
          translationJobs.set(segment.id, job);
        }
        const translatedText = await job;
        if (translatedText) segment.translated_text = translatedText;
        if (translationJobs.get(segment.id) === job) translationJobs.delete(segment.id);
      }));
    }
  }

  function englishTranscriptText(segment) {
    const translated = typeof segment.translated_text === 'string' ? segment.translated_text.trim() : '';
    if (translated && translated.toLowerCase() !== 'english translation pending') return translated;
    if (String(segment.language || '').toLowerCase().startsWith('en')) {
      const original = typeof segment.original_text === 'string' ? segment.original_text.trim() : '';
      return original || null;
    }
    return null;
  }

  function audioMimeType(request) {
    const contentType = String(request.file?.mimetype || '').split(';')[0].toLowerCase();
    if (!['audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/mpeg'].includes(contentType)) {
      fail(415, 'Unsupported audio format. Upload WebM, WAV, OGG, MP4, or MP3 audio.');
    }
    if (!request.file?.buffer?.length) fail(422, 'The audio recording is empty.');
    if (request.file.size > 20 * 1024 * 1024) fail(413, 'Audio exceeds the 20 MB limit.');
    return contentType;
  }

  function parseBusinessDate(value, timeZone = 'UTC') {
    if (!value) {
      let parts;
      try {
        parts = new Intl.DateTimeFormat('en-CA', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).formatToParts(new Date());
      } catch {
        parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'UTC',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).formatToParts(new Date());
      }
      const dateParts = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      return `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
    }
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(422, 'business_date must use YYYY-MM-DD format');
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(422, 'business_date is invalid');
    return value;
  }

  function isLiveDailyReport(payload) {
    const provider = payload?.daily_analysis?.provider_summary?.provider;
    return payload?.dataMode === 'live'
      && payload.daily_analysis?.provider_summary?.status === 'completed'
      && ![null, undefined, '', 'mock', 'demo'].includes(String(provider || '').toLowerCase());
  }

  function zonedMidnightUtc(dateText, timeZone) {
    const target = new Date(`${dateText}T00:00:00Z`);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(target);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const localAsUtc = Date.UTC(
      Number(values.year), Number(values.month) - 1, Number(values.day),
      Number(values.hour), Number(values.minute), Number(values.second),
    );
    return new Date(target.getTime() + (target.getTime() - localAsUtc));
  }

  async function dailyReportContext(store, businessDate, period = 'daily') {
    let timezone = store?.timezone || 'UTC';
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
    catch { timezone = 'UTC'; }
    const selectedDate = new Date(`${businessDate}T00:00:00Z`);
    const startDate = new Date(selectedDate);
    if (period === 'weekly') {
      startDate.setUTCDate(startDate.getUTCDate() - ((startDate.getUTCDay() + 6) % 7));
    } else if (period === 'monthly') {
      startDate.setUTCDate(1);
    }
    const nextDate = new Date(startDate);
    if (period === 'weekly') nextDate.setUTCDate(nextDate.getUTCDate() + 7);
    else if (period === 'monthly') nextDate.setUTCMonth(nextDate.getUTCMonth() + 1, 1);
    else nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const startDateText = startDate.toISOString().slice(0, 10);
    const dateAfter = nextDate.toISOString().slice(0, 10);
    const start = zonedMidnightUtc(startDateText, timezone);
    const end = zonedMidnightUtc(dateAfter, timezone);
    const now = new Date();
    const rangeEnd = end < now ? end : now;
    const conversationFilter = {
      store_id: store.id,
      started_at: { $gte: start, $lt: rangeEnd },
    };
    if (period === 'daily') conversationFilter.data_source = 'live';
    const [conversations, transactions] = await Promise.all([
      ConversationModel.find(conversationFilter).sort({ started_at: 1 }).lean(),
      PosTransactionModel.find({
        store_id: store.id,
        occurred_at: { $gte: start, $lt: rangeEnd },
        provider: { $nin: ['', 'mock', 'demo'] },
      }).sort({ occurred_at: 1 }).lean(),
    ]);
    const conversationIds = conversations.map((row) => row.id);
    const [segments, opportunities, recordings, runs, intents, storeScopedStock] = await Promise.all([
      TranscriptSegmentModel.find({ conversation_id: { $in: conversationIds } }).sort({ start_time: 1 }).lean(),
      OpportunityModel.find({ store_id: store.id, conversation_id: { $in: conversationIds } }).lean(),
      AudioRecordingModel.find({
        store_id: store.id,
        captured_at: { $gte: start, $lt: rangeEnd },
        retain_until: { $gt: new Date() },
      }).lean(),
      AiProcessingRunModel.find({ conversation_id: { $in: conversationIds }, status: 'completed' }).lean(),
      CustomerIntentModel?.find({ conversation_id: { $in: conversationIds } }).lean() || [],
      StockItemModel.find({ store_id: store.id }).lean(),
    ]);
    const realRunConversationIds = new Set(runs
      .filter((run) => !['', 'mock', 'demo'].includes(String(run.provider || '').toLowerCase()))
      .map((run) => run.conversation_id));
    const realOpportunities = period === 'daily'
      ? opportunities.filter((row) => realRunConversationIds.has(row.conversation_id))
      : opportunities;
    const realIntents = period === 'daily'
      ? intents.filter((row) => realRunConversationIds.has(row.conversation_id)
        && !['', 'mock', 'demo'].includes(String(row.source || '').toLowerCase()))
      : intents;
    const revenueByCurrency = {};
    for (const transaction of transactions) {
      const currency = transaction.currency || 'USD';
      revenueByCurrency[currency] = (revenueByCurrency[currency] || 0) + Number(transaction.amount || 0);
    }
    const intentCounts = new Map();
    for (const intent of realIntents) intentCounts.set(intent.intent, (intentCounts.get(intent.intent) || 0) + 1);
    const topIntents = [...intentCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([intent, count]) => ({ intent, count }));
    const converted = realOpportunities.filter((row) => row.status === 'CONVERTED').length;
    const missed = realOpportunities.filter((row) => row.status === 'MISSED').length;
    const staffSegments = segments.filter((row) => String(row.speaker_id || '').startsWith('speaker-employee-'));
    const attributedCustomers = segments.filter((row) => row.speaker_id === 'speaker-customer').length;
    const staffQuestions = staffSegments.filter((row) => String(row.original_text || '').includes('?')).length;
    const acknowledgements = new Set(['ok', 'okay', 'yes', 'yeah', 'sure', 'right', 'got it', 'no problem']);
    const briefAcknowledgements = staffSegments.filter((row) => acknowledgements.has(String(row.original_text || '').trim().toLowerCase().replace(/[.,!?]+$/g, ''))).length;
    const countByLanguage = {};
    for (const row of conversations) countByLanguage[row.primary_language || 'und'] = (countByLanguage[row.primary_language || 'und'] || 0) + 1;
    const durationSeconds = recordings.reduce((sum, row) => sum + Number(row.duration_seconds || 0), 0);
    const lowStock = storeScopedStock.filter((item) => Number(item.quantity || 0) <= Number(item.par_level || 0)).length;
    const payload = {
      range_start: start.toISOString(),
      range_end: rangeEnd.toISOString(),
      business_date: businessDate,
      timezone,
      metrics: {
        conversations: conversations.length,
        sales_opportunities: realOpportunities.length,
        converted_opportunities: converted,
        potential_missed_opportunities: missed,
        conversion_rate: realOpportunities.length ? Number((converted / realOpportunities.length).toFixed(2)) : 0,
        language_distribution: countByLanguage,
        pos_correlated: 0,
        sales_count: transactions.length,
        sales_data_available: transactions.length > 0,
        revenue_by_currency: Object.fromEntries(Object.entries(revenueByCurrency).map(([currency, amount]) => [currency, Number(amount.toFixed(2))])),
        audio_recordings: recordings.length,
        recorded_seconds: Number(durationSeconds.toFixed(2)),
        transcript_segments: segments.length,
        low_stock: lowStock,
      },
      store_performance: [{
        store_id: store.id,
        conversations: conversations.length,
        opportunities: realOpportunities.length,
        converted,
        missed,
        conversion_rate: realOpportunities.length ? Number((converted / realOpportunities.length).toFixed(2)) : 0,
      }],
      daily_analysis: {
        top_intents: topIntents,
        potential_product_mentions: [],
        ai_analysis_runs: period === 'daily' ? realRunConversationIds.size : runs.length,
        interaction_summary: `${attributedCustomers} customer-labeled, ${staffSegments.length} staff-labeled, and ${segments.length - attributedCustomers - staffSegments.length} unattributed transcript clips. This is not an objective staff-quality score.`,
        staff_interaction_signals: {
          labeled_staff_clips: staffSegments.length,
          clips_with_question_marks: staffQuestions,
          brief_acknowledgement_clips: briefAcknowledgements,
          coverage: staffSegments.length ? 'available_from_operator_labeled_clips' : 'insufficient_staff_attribution',
          caveat: 'These are transcription-text counts, not an assessment of service quality. Unknown clips are excluded.',
        },
        sales_summary: transactions.length
          ? `${transactions.length} POS transactions totaling ${Object.values(revenueByCurrency).reduce((sum, amount) => sum + amount, 0).toFixed(2)} were recorded.`
          : 'Live POS sales data is unavailable; no revenue or zero-sales claim can be reported.',
        potential_unconverted_opportunities: realOpportunities.filter((row) => ['OPEN', 'REVIEW_REQUIRED'].includes(row.status)).length,
        caveat: 'Potential signals are not proof of why a sale was or was not made. Unknown clips are not attributed.',
      },
      caveat: 'AI-assisted metrics. Not a determination of employee performance.',
      dataMode: config.demoMode ? 'demo' : 'live',
    };
    return { report: payload, conversations, segments, realOpportunities, transactions, recordings, runs, store };
  }

  function combineReportContexts(contexts, period) {
    const reports = contexts.map((context) => context.report);
    if (reports.length === 1) return reports[0];
    const metrics = {};
    for (const key of new Set(reports.flatMap((report) => Object.keys(report.metrics || {})))) {
      const values = reports.map((report) => report.metrics?.[key]);
      if (key === 'revenue_by_currency' || key === 'language_distribution') {
        metrics[key] = values.reduce((combined, value) => {
          for (const [name, amount] of Object.entries(value || {})) combined[name] = (combined[name] || 0) + Number(amount || 0);
          return combined;
        }, {});
      } else if (key === 'sales_data_available') {
        metrics[key] = values.some(Boolean);
      } else if (values.every((value) => typeof value === 'number')) {
        metrics[key] = values.reduce((sum, value) => sum + value, 0);
      } else {
        metrics[key] = values[0];
      }
    }
    metrics.conversion_rate = metrics.sales_opportunities
      ? Number((metrics.converted_opportunities / metrics.sales_opportunities).toFixed(2))
      : 0;
    const intents = new Map();
    for (const report of reports) {
      for (const item of report.daily_analysis?.top_intents || []) {
        intents.set(item.intent, (intents.get(item.intent) || 0) + Number(item.count || 0));
      }
    }
    const dailyAnalysis = {
      ...reports[0]?.daily_analysis,
      top_intents: [...intents.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5).map(([intent, count]) => ({ intent, count })),
      ai_analysis_runs: reports.reduce((sum, report) => sum + Number(report.daily_analysis?.ai_analysis_runs || 0), 0),
      potential_unconverted_opportunities: reports.reduce((sum, report) => sum + Number(report.daily_analysis?.potential_unconverted_opportunities || 0), 0),
      sales_summary: metrics.sales_data_available
        ? `${metrics.sales_count} POS transactions were recorded across accessible stores.`
        : 'Live POS sales data is unavailable; no revenue or zero-sales claim can be reported.',
    };
    return {
      range_start: reports.map((report) => report.range_start).filter(Boolean).sort()[0] || '',
      range_end: reports.map((report) => report.range_end).filter(Boolean).sort().at(-1) || '',
      business_date: reports[0]?.business_date,
      timezone: contexts.length === 1 ? reports[0]?.timezone : 'UTC',
      metrics,
      store_performance: reports.flatMap((report) => report.store_performance || []),
      daily_analysis: dailyAnalysis,
      caveat: 'AI-assisted metrics. Not a determination of employee performance.',
      dataMode: config.demoMode ? 'demo' : 'live',
    };
  }

  async function serializeConversationRows(rows) {
    if (!rows.length) return [];
    const storeIds = [...new Set(rows.map((row) => row.store_id))];
    const employeeIds = [...new Set(rows.map((row) => row.employee_id).filter(Boolean))];
    const [stores, employees] = await Promise.all([
      StoreModel.find({ id: { $in: storeIds } }).lean(),
      EmployeeModel?.find({ id: { $in: employeeIds } }).lean() || [],
    ]);
    const storeNames = new Map(stores.map((store) => [store.id, store.name]));
    const employeeNames = new Map(employees.map((employee) => [employee.id, employee.full_name]));
    return rows.map((item) => ({
      id: item.id,
      store_id: item.store_id,
      store_name: storeNames.get(item.store_id) || item.store_id,
      started_at: item.started_at?.toISOString?.() || null,
      ended_at: item.ended_at?.toISOString?.() || null,
      status: item.status,
      language: item.primary_language || 'und',
      product: item.detected_product || null,
      customer_intent: item.customer_intent || null,
      salesperson: employeeNames.get(item.employee_id) || 'Unassigned',
      opportunity_status: item.opportunity_status || 'UNKNOWN',
    }));
  }

  app.get('/api/v1/dashboard/summary', authenticate, async (request, response, next) => {
    try {
      const storeFilter = request.user.role === 'SUPER_ADMIN' ? {} : { organization_id: request.user.organization_id };
      const stores = await StoreModel.find(storeFilter).sort({ name: 1 }).lean();
      const storeIds = stores.map((store) => store.id);
      const scope = storeIds.length ? { store_id: { $in: storeIds } } : { store_id: { $in: [] } };
      const now = new Date();
      const since = new Date(now.getTime() - 7 * 86_400_000);
      const [devices, conversations, opportunities, alerts, transactions, recordings, employees] = await Promise.all([
        DeviceModel?.find({ ...scope, revoked: { $ne: true } }).lean() || [],
        ConversationModel.find(scope).sort({ started_at: -1 }).lean(),
        OpportunityModel?.find(scope).sort({ created_at: -1 }).lean() || [],
        AlertModel?.find({ ...scope, acknowledged: { $ne: true } }).sort({ created_at: -1 }).limit(8).lean() || [],
        PosTransactionModel?.find({ ...scope, occurred_at: { $gte: since }, provider: { $ne: 'mock' } }).lean() || [],
        AudioRecordingModel.find({ ...scope, captured_at: { $gte: since } }).lean(),
        EmployeeModel?.find({ ...scope, active: true }).lean() || [],
      ]);
      const deviceByStore = new Map();
      for (const device of devices) if (!deviceByStore.has(device.store_id)) deviceByStore.set(device.store_id, device);
      const employeesByStore = new Map();
      for (const employee of employees) employeesByStore.set(employee.store_id, (employeesByStore.get(employee.store_id) || 0) + 1);
      const liveByStore = new Map();
      for (const conversation of conversations) if (conversation.status === 'LIVE') liveByStore.set(conversation.store_id, (liveByStore.get(conversation.store_id) || 0) + 1);
      const visibleStores = stores.map((store) => {
        const device = deviceByStore.get(store.id);
        return {
          ...store,
          online: Boolean(device && device.status === 'connected'),
          device_connected: Boolean(device && device.status === 'connected'),
          device: device || null,
          open_conversations: liveByStore.get(store.id) || 0,
          employees: employeesByStore.get(store.id) || 0,
        };
      });
      const converted = opportunities.filter((item) => item.status === 'CONVERTED').length;
      const missed = opportunities.filter((item) => item.status === 'MISSED').length;
      const revenue = {};
      for (const sale of transactions) revenue[sale.currency || 'USD'] = (revenue[sale.currency || 'USD'] || 0) + Number(sale.amount || 0);
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const todayCount = conversations.filter((row) => row.started_at && new Date(row.started_at) >= today).length;
      const trends = Array.from({ length: 7 }, (_, index) => {
        const date = new Date(today.getTime() - (6 - index) * 86_400_000);
        return conversations.filter((row) => row.started_at && new Date(row.started_at).toDateString() === date.toDateString()).length;
      });
      const languages = {};
      for (const row of conversations) languages[row.primary_language || 'und'] = (languages[row.primary_language || 'und'] || 0) + 1;
      const recentConversations = await serializeConversationRows(conversations.slice(0, 8));
      const missedByCategory = {};
      for (const item of opportunities.filter((row) => row.status === 'MISSED')) {
        const product = String(item.product_name || 'Other').toLowerCase();
        const category = product.includes('charg') ? 'Charger' : /iphone|phone/.test(product) ? 'Phone models' : 'Other';
        missedByCategory[category] = (missedByCategory[category] || 0) + 1;
      }
      return response.json({
        generated_at: now.toISOString(),
        dataMode: config.demoMode ? 'demo' : 'live',
        stores: visibleStores,
        metrics: {
          active_stores: stores.length,
          online_stores: visibleStores.filter((store) => store.online).length,
          offline_stores: visibleStores.filter((store) => !store.online).length,
          live_conversations: conversations.filter((row) => row.status === 'LIVE').length,
          conversations_today: todayCount,
          total_conversations: conversations.length,
          analyzed_conversations: new Set(opportunities.map((row) => row.conversation_id)).size,
          potential_missed_opportunities: missed,
          sales_opportunities: opportunities.length,
          converted_opportunities: converted,
          conversion_rate: opportunities.length ? Number((converted / opportunities.length).toFixed(2)) : 0,
          average_response_time_seconds: null,
          language_distribution: languages,
          conversation_trend: trends,
          missed_by_category: missedByCategory,
          manager_review_required: opportunities.filter((row) => row.status === 'REVIEW_REQUIRED').length,
          pos_correlated: await PosMatchModel?.countDocuments({ conversation_id: { $in: conversations.map((row) => row.id) } }) || 0,
          sales_count_7d: transactions.length,
          revenue_by_currency_7d: Object.fromEntries(Object.entries(revenue).map(([currency, amount]) => [currency, Number(amount.toFixed(2))])),
          listening_seconds_7d: Number(recordings.reduce((sum, row) => sum + Number(row.duration_seconds || 0), 0).toFixed(2)),
          recorders_online: visibleStores.filter((store) => store.device_connected).length,
          recorders_total: devices.length,
        },
        live_transcripts: [],
        recent_conversations: recentConversations,
        opportunities: opportunities.slice(0, 8).map((item) => ({
          id: item.id,
          store_id: item.store_id,
          conversation_id: item.conversation_id,
          customer_intent: item.customer_intent,
          product: item.product_name,
          status: item.status,
          confidence: item.confidence,
          recommendation: item.recommendation,
          created_at: item.created_at?.toISOString?.() || null,
          manager_note: item.manager_note || null,
          insight_caveat: 'AI-generated insight with confidence; not a verified fact.',
        })),
        recommendations: [],
        alerts: alerts.slice(0, 8),
      });
    } catch (error) { return next(error); }
  });

  function deviceIsApproved(device) {
    if (device.revoked) return false;
    const status = device.approval_status || (device.status === 'registered' ? 'approved' : 'pending');
    return status === 'approved';
  }

  app.get('/api/v1/auth/me', authenticate, (request, response) => {
    const user = request.user;
    return response.json({
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      store_id: user.store_id ?? null,
      organization_id: user.organization_id,
    });
  });

  app.get('/api/v1/devices/:deviceId/approval', audioActor, async (request, response, next) => {
    try {
      let device;
      if (request.audioActor.device) {
        if (request.audioActor.device.id !== request.params.deviceId) {
          return response.status(403).json({ detail: 'Device credentials do not match this device' });
        }
        device = request.audioActor.device;
      } else {
        const filter = { id: request.params.deviceId };
        if (request.audioActor.user.role !== 'SUPER_ADMIN') {
          const storeIds = (await StoreModel.find({ organization_id: request.audioActor.user.organization_id }).select({ id: 1 }).lean()).map((store) => store.id);
          filter.store_id = { $in: storeIds };
        }
        device = await DeviceModel.findOne(filter).lean();
      }
      if (!device) return response.status(404).json({ detail: 'Device not found' });
      const approvalStatus = device.revoked ? 'rejected' : (device.approval_status || (device.status === 'registered' ? 'approved' : 'pending'));
      return response.json({
        device_id: device.id,
        approval_status: approvalStatus,
        approved: approvalStatus === 'approved',
        status: device.status,
        revoked: Boolean(device.revoked),
      });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/devices/register', authenticate, async (request, response, next) => {
    try {
      if (!['SUPER_ADMIN', 'ORG_ADMIN', 'STORE_MANAGER'].includes(request.user.role)) {
        return response.status(403).json({ detail: 'Store management access required' });
      }
      const store = await accessibleStore(String(request.body?.store_id || ''), { user: request.user });
      if (!store) return response.status(404).json({ detail: 'Store not found' });
      const secret = randomBytes(32).toString('base64url');
      const device = {
        id: `device-${randomBytes(4).toString('hex')}`,
        store_id: store.id,
        name: String(request.body?.name || 'Store edge device').slice(0, 120),
        status: 'pending',
        approval_status: 'pending',
        audio_source: String(request.body?.audio_source || 'microphone').slice(0, 40),
        version: '1.0.0',
        secret_hash: (await import('node:crypto')).createHash('sha256').update(secret).digest('hex'),
        revoked: false,
        approved_at: null,
        approved_by: null,
      };
      await DeviceModel.create(device);
      if (AuditLogModel) await AuditLogModel.create({
        id: `aud-${randomBytes(5).toString('hex')}`,
        actor_id: request.user.id,
        action: 'device.registered',
        entity: 'store_device',
        entity_id: device.id,
        detail: `${store.id};pending`,
        created_at: new Date(),
      });
      return response.status(201).json({
        device_id: device.id,
        device_secret: secret,
        approval_status: 'pending',
        note: 'Device registered and waiting for administrator approval.',
      });
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/devices/pending', authenticate, async (request, response, next) => {
    try {
      if (!['SUPER_ADMIN', 'ORG_ADMIN'].includes(request.user.role)) {
        return response.status(403).json({ detail: 'Organization administrator access required' });
      }
      const storeFilter = request.user.role === 'SUPER_ADMIN' ? {} : { organization_id: request.user.organization_id };
      const stores = await StoreModel.find(storeFilter).select({ id: 1, name: 1, city: 1, region: 1 }).lean();
      const storeById = new Map(stores.map((store) => [store.id, store]));
      const devices = await DeviceModel.find({ store_id: { $in: [...storeById.keys()] }, revoked: { $ne: true } }).lean();
      const pending = devices.filter((device) => (device.approval_status || 'pending') === 'pending')
        .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')))
        .map((device) => {
          const store = storeById.get(device.store_id);
          return {
            id: device.id,
            name: device.name,
            store_id: device.store_id,
            store_name: store?.name || device.store_id,
            store_city: store?.city || '',
            store_region: store?.region || '',
            status: device.status,
            approval_status: device.approval_status || 'pending',
            audio_source: device.audio_source || 'microphone',
            version: device.version || '1.0.0',
            last_heartbeat: device.last_heartbeat?.toISOString?.() || null,
            revoked: Boolean(device.revoked),
            approved_at: device.approved_at?.toISOString?.() || null,
          };
        });
      return response.json({ devices: pending, total: pending.length });
    } catch (error) { return next(error); }
  });

  for (const [action, status] of [['approve', 'approved'], ['reject', 'rejected']]) {
    app.post(`/api/v1/devices/:deviceId/${action}`, authenticate, async (request, response, next) => {
      try {
        if (!['SUPER_ADMIN', 'ORG_ADMIN'].includes(request.user.role)) {
          return response.status(403).json({ detail: 'Organization administrator access required' });
        }
        const device = await DeviceModel.findOne({ id: request.params.deviceId });
        if (!device) return response.status(404).json({ detail: 'Device not found' });
        const store = await accessibleStore(device.store_id, { user: request.user });
        if (!store) return response.status(404).json({ detail: 'Device not found' });
        if (device.revoked && action === 'approve') return response.status(409).json({ detail: 'Revoked devices cannot be approved' });
        device.approval_status = status;
        device.status = action === 'approve' ? 'registered' : 'rejected';
        device.approved_at = action === 'approve' ? new Date() : null;
        device.approved_by = request.user.id;
        await device.save();
        const event = {
          event: `device.${action === 'approve' ? 'approved' : 'rejected'}`,
          deviceId: device.id,
          storeId: device.store_id,
          approvalStatus: status,
          timestamp: new Date().toISOString(),
        };
        sockets?.publish(`store:${device.store_id}`, event);
        sockets?.publish('dashboard', event);
        return response.json({
          id: device.id,
          name: device.name,
          store_id: device.store_id,
          store_name: store.name,
          store_city: store.city || '',
          store_region: store.region || '',
          status: device.status,
          approval_status: device.approval_status,
          audio_source: device.audio_source || 'microphone',
          version: device.version || '1.0.0',
          last_heartbeat: device.last_heartbeat?.toISOString?.() || null,
          revoked: Boolean(device.revoked),
          approved_at: device.approved_at?.toISOString?.() || null,
        });
      } catch (error) { return next(error); }
    });
  }

  app.post('/api/v1/devices/:deviceId/revoke', authenticate, async (request, response, next) => {
    try {
      const device = await DeviceModel.findOne({ id: request.params.deviceId });
      if (!device || !await accessibleStore(device.store_id, { user: request.user })) {
        return response.status(404).json({ detail: 'Device not found' });
      }
      if (!['SUPER_ADMIN', 'ORG_ADMIN', 'STORE_MANAGER'].includes(request.user.role)) {
        return response.status(403).json({ detail: 'Store management access required' });
      }
      device.revoked = true;
      device.status = 'revoked';
      device.approval_status = 'rejected';
      await device.save();
      return response.json({ device_id: device.id, status: device.status });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/audio/sessions', audioActor, async (request, response, next) => {
    try {
      const storeId = String(request.body?.store_id || '').trim();
      const store = await accessibleStore(storeId, request.audioActor);
      if (!store) return response.status(404).json({ detail: 'Store not found' });
      const { device } = request.audioActor;
      if (device && !deviceIsApproved(device)) {
        return response.status(403).json({ detail: `Recording is blocked because this device is ${device.approval_status || 'pending'} or revoked.` });
      }
      const now = new Date();
      const conversation = {
        id: `conv-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        store_id: store.id,
        data_source: 'live',
        status: 'LIVE',
        primary_language: 'und',
        opportunity_status: 'UNKNOWN',
        started_at: now,
      };
      await ConversationModel.create(conversation);
      if (AudioSessionModel && device) {
        await AudioSessionModel.create({
          id: `session-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
          store_id: store.id,
          device_id: device.id,
          conversation_id: conversation.id,
          source_type: 'live',
          retain_until: new Date(now.getTime() + config.audioRetentionDays * 86_400_000),
          stored_audio: false,
        });
      }
      sockets?.publish(`store:${store.id}`, {
        event: 'conversation.started',
        conversationId: conversation.id,
        storeId: store.id,
        status: 'LIVE',
        timestamp: now.toISOString(),
      });
      return response.status(201).json({ conversation_id: conversation.id, store_id: store.id, status: 'LIVE' });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/audio/sessions/:conversationId/finish', audioActor, async (request, response, next) => {
    try {
      const filter = { id: request.params.conversationId };
      if (request.audioActor.device) filter.store_id = request.audioActor.device.store_id;
      else if (request.audioActor.user.role !== 'SUPER_ADMIN') {
        filter.store_id = request.audioActor.user.role === 'STORE_MANAGER'
          ? request.audioActor.user.store_id
          : { $in: (await StoreModel.find({ organization_id: request.audioActor.user.organization_id }).select({ id: 1 }).lean()).map((store) => store.id) };
      }
      const conversation = await ConversationModel.findOne(filter);
      if (!conversation) return response.status(404).json({ detail: 'Audio session not found' });
      if (conversation.status === 'LIVE') {
        conversation.status = 'ENDED';
        conversation.ended_at = new Date();
        await conversation.save();
        sockets?.publish(`store:${conversation.store_id}`, {
          event: 'conversation.ended',
          conversationId: conversation.id,
          storeId: conversation.store_id,
          status: 'ENDED',
          timestamp: conversation.ended_at.toISOString(),
        });
      }
      const recordingCount = AudioRecordingModel
        ? await AudioRecordingModel.countDocuments({ conversation_id: conversation.id })
        : 0;
      return response.json({
        conversation_id: conversation.id,
        status: conversation.status,
        ended_at: conversation.ended_at?.toISOString() || null,
        recording_id: null,
        recordings: recordingCount,
      });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/audio/transcribe/preview', audioActor, audioUpload.single('audio'), async (request, response, next) => {
    try {
      const contentType = audioMimeType(request);
      const storeId = requiredText(request.body, 'store_id', 64);
      const conversationId = requiredText(request.body, 'conversation_id', 64);
      const store = await accessibleStore(storeId, request.audioActor);
      if (!store) return response.status(404).json({ detail: 'Store not found' });
      const conversation = await ConversationModel.findOne({ id: conversationId, store_id: store.id, status: 'LIVE' }).lean();
      if (!conversation) return response.status(404).json({ detail: 'Live audio session not found' });
      if (request.audioActor.device && !deviceIsApproved(request.audioActor.device)) {
        return response.status(403).json({ detail: 'This device is not approved for live transcription.' });
      }
      const startedAt = Date.now();
      const result = await deepgramTranscriber({
        audio: request.file.buffer,
        mimeType: contentType,
        apiKey: config.deepgramApiKey,
      });
      if (!result.transcript) {
        return response.json({
          segment: null,
          preview_sequence: Number(request.body.preview_sequence) || 0,
          transcription_ms: Date.now() - startedAt,
          preview_status: 'no_speech',
        });
      }
      const translated = await toEnglishTranscript(result.transcript, result.language);
      const event = {
        event: 'transcript.partial',
        conversationId: conversation.id,
        storeId: store.id,
        segmentId: `preview-${conversation.id}-${Number(request.body.capture_sequence) || 0}`,
        captureSequence: Number(request.body.capture_sequence) || 0,
        previewSequence: Number(request.body.preview_sequence) || 0,
        speakerLabel: 'Live transcript',
        language: result.language,
        originalText: result.transcript,
        translatedText: translated.translatedText || '',
        englishText: translated.englishText,
        confidence: result.confidence,
        isFinal: false,
        source: 'deepgram_preview',
        transcriptionMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      };
      sockets?.publish(`store:${store.id}`, event);
      return response.json({
        segment: event,
        preview_sequence: event.previewSequence,
        transcription_ms: event.transcriptionMs,
        preview_status: translated.translationStatus,
        request_id: result.requestId,
      });
    } catch (error) {
      if (error.status) return next(error);
      console.error(`Preview transcription failed rid=${request.id}`, error);
      return response.status(503).json({ detail: 'Deepgram preview transcription failed. Check DEEPGRAM_API_KEY and retry.', request_id: request.id });
    }
  });

  app.post('/api/v1/audio/transcribe', audioActor, audioUpload.single('audio'), async (request, response, next) => {
    let storageKey;
    try {
      const contentType = audioMimeType(request);
      const storeId = requiredText(request.body, 'store_id', 64);
      const store = await accessibleStore(storeId, request.audioActor);
      if (!store) return response.status(404).json({ detail: 'Store not found' });
      if (request.audioActor.device && (
        request.body.speaker_role && request.body.speaker_role !== 'unknown'
        || request.body.employee_id
      )) return response.status(403).json({ detail: 'Store devices must submit mixed audio with unknown speaker attribution.' });
      if (request.audioActor.device && !deviceIsApproved(request.audioActor.device)) {
        return response.status(403).json({ detail: 'This device is not approved for live transcription.' });
      }
      const speakerRole = request.body.speaker_role || 'unknown';
      if (!['customer', 'employee', 'unknown'].includes(speakerRole)) return response.status(422).json({ detail: 'Invalid speaker_role' });
      let employee = null;
      if (speakerRole === 'employee') {
        if (!request.body.employee_id) return response.status(422).json({ detail: 'Select a staff member before recording a staff turn.' });
        employee = await EmployeeModel.findOne({
          id: request.body.employee_id,
          store_id: store.id,
          active: { $ne: false },
        }).lean();
        if (!employee) return response.status(404).json({ detail: 'Staff member not found for this store' });
      } else if (request.body.employee_id) {
        return response.status(422).json({ detail: 'Only an employee turn can include an employee_id.' });
      }

      let conversation;
      if (request.body.conversation_id) {
        conversation = await ConversationModel.findOne({
          id: String(request.body.conversation_id),
          store_id: store.id,
          status: 'LIVE',
        }).lean();
        if (!conversation) return response.status(404).json({ detail: 'Conversation not found for this store' });
      } else {
        conversation = await ConversationModel.findOne({ store_id: store.id, status: 'LIVE' }).sort({ started_at: -1 }).lean();
        if (!conversation) {
          conversation = {
            id: `conv-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
            store_id: store.id,
            data_source: 'live',
            status: 'LIVE',
            primary_language: 'und',
            opportunity_status: 'UNKNOWN',
            started_at: new Date(),
          };
          await ConversationModel.create(conversation);
        }
      }

      const captureAt = new Date();
      storageKey = await audioStorage.save(request.file.buffer, contentType, captureAt);
      const recording = await AudioRecordingModel.create({
        id: `audio-${randomUUID().replaceAll('-', '').slice(0, 16)}`,
        store_id: store.id,
        conversation_id: conversation.id,
        storage_key: storageKey,
        content_type: contentType,
        byte_size: request.file.size,
        duration_seconds: Math.min(60, Math.max(0.1, Number(request.body.duration_seconds) || 8)),
        sequence: Math.max(0, Number.parseInt(request.body.capture_sequence || '0', 10) || 0),
        speaker_role: speakerRole,
        is_aggregate: false,
        captured_at: captureAt,
        retain_until: new Date(captureAt.getTime() + config.audioRetentionDays * 86_400_000),
      });

      const transcriptionStarted = Date.now();
      let result;
      try {
        result = await deepgramTranscriber({
          audio: request.file.buffer,
          mimeType: contentType,
          apiKey: config.deepgramApiKey,
        });
      } catch (error) {
        console.error(`Deepgram transcription failed rid=${request.id}`, error);
        return response.status(503).json({
          detail: 'Deepgram transcription failed. Check DEEPGRAM_API_KEY, audio format, and provider access.',
          request_id: request.id,
          audio_recording_id: recording.id,
          raw_audio_stored: true,
        });
      }
      const transcriptionMs = Date.now() - transcriptionStarted;
      if (!result.transcript) {
        return response.json({
          conversation_id: conversation.id,
          segment: null,
          speech_provider: 'deepgram',
          analysis: null,
          analysis_status: 'no_speech',
          transcription_ms: transcriptionMs,
          raw_audio_stored: true,
          audio_recording_id: recording.id,
          request_id: result.requestId,
        });
      }

      const translated = await toEnglishTranscript(result.transcript, result.language);
      const segmentId = `seg-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const speakerId = speakerRole === 'customer'
        ? 'speaker-customer'
        : employee ? `speaker-${employee.id}` : 'speaker-unknown';
      const duration = Math.min(60, Math.max(0.1, Number(request.body.duration_seconds) || 8));
      const offset = Math.max(0, Number(request.body.session_offset_seconds) || 0);
      const segment = await TranscriptSegmentModel.create({
        id: segmentId,
        conversation_id: conversation.id,
        speaker_id: speakerId,
        language: result.language,
        original_text: result.transcript,
        translated_text: translated.translatedText,
        start_time: offset,
        end_time: offset + duration,
        confidence: result.confidence,
        is_final: true,
        created_at: new Date(),
      });
      const speakerLabel = employee
        ? `Staff: ${employee.full_name} (operator selected)`
        : speakerRole === 'customer' ? 'Customer (operator selected)' : 'Speaker';
      await ParticipantModel.create({
        id: `participant-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        conversation_id: conversation.id,
        speaker_label: speakerLabel,
        mapped_role: speakerRole,
        employee_id: employee?.id || null,
      });
      await ConversationModel.updateOne(
        { id: conversation.id },
        { $set: { primary_language: result.language, employee_id: employee?.id || conversation.employee_id || null } },
      );
      const event = {
        event: 'transcript.final',
        conversationId: conversation.id,
        segmentId: segment.id,
        storeId: store.id,
        captureSequence: Number(request.body.capture_sequence) || 0,
        speakerId,
        speakerLabel,
        speakerRole,
        employeeId: employee?.id || null,
        language: result.language,
        originalText: result.transcript,
        translatedText: translated.translatedText || '',
        englishText: translated.englishText,
        confidence: result.confidence,
        isFinal: true,
        source: 'deepgram',
        transcriptionMs,
        timestamp: segment.created_at.toISOString(),
      };
      sockets?.publish(`store:${store.id}`, event);
      return response.json({
        conversation_id: conversation.id,
        segment: event,
        speech_provider: 'deepgram',
        transcription_ms: transcriptionMs,
        analysis: null,
        analysis_status: speakerRole === 'unknown' ? 'speaker_unattributed' : 'pending',
        translation_status: translated.translationStatus,
        raw_audio_stored: true,
        audio_recording_id: recording.id,
        request_id: result.requestId,
      });
    } catch (error) {
      if (storageKey) {
        try { await audioStorage.delete(storageKey); } catch (cleanupError) {
          console.error(`Audio cleanup failed rid=${request.id}`, cleanupError);
        }
      }
      if (error.status) return next(error);
      console.error(`Audio transcription request failed rid=${request.id}`, error);
      return response.status(503).json({ detail: 'Audio transcription could not be completed.', request_id: request.id });
    }
  });

  app.post('/api/v1/audio/coaching/:conversationId', audioActor, coachingLimiter, async (request, response, next) => {
    try {
      let conversationFilter = { id: request.params.conversationId };
      if (request.audioActor.device) {
        if (!deviceIsApproved(request.audioActor.device)) {
          return response.status(403).json({ detail: 'This device is not approved for live coaching.' });
        }
        conversationFilter.store_id = request.audioActor.device.store_id;
      } else {
        conversationFilter = {
          ...conversationFilter,
          ...await scopedStoreFilter(request.audioActor.user),
        };
      }
      const conversation = await ConversationModel.findOne(conversationFilter).lean();
      if (!conversation || conversation.status !== 'LIVE') return response.status(404).json({ detail: 'Live conversation not found' });
      const segments = await TranscriptSegmentModel.find({ conversation_id: conversation.id })
        .sort({ start_time: -1, created_at: -1, id: -1 })
        .limit(5)
        .lean();
      await repairMissingTranslations(segments);
      const contextLines = segments.reverse().map((segment) => ({
        speaker: segment.speaker_id === 'speaker-customer' ? 'customer'
          : segment.speaker_id?.startsWith('speaker-employee-') ? 'employee' : 'unknown',
        text: englishTranscriptText(segment) || String(segment.original_text || '').trim(),
      })).filter((line) => line.text);
      if (!contextLines.length) return response.status(409).json({ detail: 'No readable conversation text is ready for coaching yet.' });
      if (!config.groqApiKey) return response.status(503).json({ detail: 'Live AI coaching is not configured. Set GROQ_API_KEY on the backend service.' });
      const [inventory, storeRules] = await Promise.all([
        StockItemModel?.find({ store_id: conversation.store_id }).limit(30).lean() || [],
        StoreRuleModel?.find({ store_id: conversation.store_id, active: true }).limit(20).lean() || [],
      ]);
      const output = await groqCoaching({
        apiKey: config.groqApiKey,
        model: config.groqModel,
        transcript: contextLines,
        inventory: inventory.map((item) => ({
          name: item.name,
          sku: item.sku,
          price: typeof item.price === 'number' && Number.isFinite(item.price) ? item.price : null,
          quantity: typeof item.quantity === 'number' && Number.isFinite(item.quantity) ? item.quantity : null,
        })),
        storeRules: storeRules.map((rule) => ({
          name: rule.name,
          trigger: rule.trigger_condition,
          action: rule.expected_action,
        })),
      });
      return response.json({
        conversation_id: conversation.id,
        context_turns: contextLines.length,
        suggestion: {
          title: 'Suggested response',
          message: output.recommendation,
          confidence: Math.min(1, Math.max(0, Number(output.confidence) || 0)),
        },
        alerts: output.alerts,
        provider: output.provider,
        updated_at: new Date().toISOString(),
      });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/audio/recordings', audioActor, audioUpload.single('audio'), async (request, response, next) => {
    let storageKey;
    try {
      if (!request.file?.buffer?.length) return response.status(422).json({ detail: 'The audio recording is empty' });
      const storeId = String(request.body.store_id || '').trim();
      const conversationId = String(request.body.conversation_id || '').trim();
      const store = await accessibleStore(storeId, request.audioActor);
      if (!store) return response.status(404).json({ detail: 'Store not found' });
      const conversationFilter = { id: conversationId, store_id: store.id };
      const conversation = await ConversationModel.findOne(conversationFilter).lean();
      if (!conversation || conversation.status !== 'LIVE') return response.status(404).json({ detail: 'Live audio session not found' });

      const contentType = (request.file.mimetype || '').split(';')[0].toLowerCase();
      const isAggregate = request.body.is_aggregate === 'true';
      const requestedDuration = Number(request.body.duration_seconds);
      if (isAggregate && (!Number.isFinite(requestedDuration) || requestedDuration <= 0 || requestedDuration > 3600)) {
        return response.status(422).json({ detail: 'Full recording duration must be between 0 and 3600 seconds.' });
      }
      const captureAt = new Date();
      storageKey = await audioStorage.save(request.file.buffer, contentType, captureAt);
      const retainDays = config.audioRetentionDays;
      const recording = await AudioRecordingModel.create({
        id: `audio-${randomUUID().replaceAll('-', '').slice(0, 16)}`,
        store_id: store.id,
        conversation_id: conversation.id,
        storage_key: storageKey,
        content_type: contentType,
        byte_size: request.file.size,
        duration_seconds: isAggregate
          ? requestedDuration
          : Math.min(60, Math.max(0.1, Number(request.body.duration_seconds) || 0.1)),
        sequence: isAggregate ? 0 : Math.max(0, Number.parseInt(request.body.capture_sequence || '0', 10) || 0),
        speaker_role: 'unknown',
        is_aggregate: isAggregate,
        captured_at: captureAt,
        retain_until: new Date(captureAt.getTime() + retainDays * 86_400_000),
      });
      return response.status(201).json({ id: recording.id, stored: true, byte_size: recording.byte_size });
    } catch (error) {
      if (storageKey) {
        try { await audioStorage.delete(storageKey); } catch (cleanupError) {
          console.error('Failed to remove uploaded audio after recording persistence failed:', cleanupError);
        }
      }
      return next(error);
    }
  });

  app.get('/api/v1/stores', authenticate, async (request, response, next) => {
    try {
      const page = Math.max(1, Number.parseInt(request.query.page || '1', 10) || 1);
      const pageSize = Math.min(100, Math.max(1, Number.parseInt(request.query.page_size || '25', 10) || 25));
      const filter = request.user.role === 'SUPER_ADMIN' ? {} : { organization_id: request.user.organization_id };
      const allStores = await StoreModel.find(filter).sort({ name: 1 }).lean();
      const query = String(request.query.q || '').trim().toLowerCase();
      const online = request.query.online;
      const filtered = allStores.filter((store) => {
        const textMatches = !query || [store.name, store.code, store.city, store.region].some((value) => String(value || '').toLowerCase().includes(query));
        return textMatches && (online === undefined || Boolean(store.online) === (online === 'true'));
      });
      const [devices, conversations, employees] = await Promise.all([
        DeviceModel?.find({ store_id: { $in: filtered.map((store) => store.id) }, revoked: { $ne: true } }).lean() || [],
        ConversationModel?.find({ store_id: { $in: filtered.map((store) => store.id) }, status: 'LIVE' }).lean() || [],
        EmployeeModel?.find({ store_id: { $in: filtered.map((store) => store.id) }, active: true }).lean() || [],
      ]);
      const deviceByStore = new Map();
      for (const device of devices) if (!deviceByStore.has(device.store_id)) deviceByStore.set(device.store_id, device);
      const liveByStore = new Map();
      for (const conversation of conversations) liveByStore.set(conversation.store_id, (liveByStore.get(conversation.store_id) || 0) + 1);
      const employeeByStore = new Map();
      for (const employee of employees) employeeByStore.set(employee.store_id, (employeeByStore.get(employee.store_id) || 0) + 1);
      const serialized = filtered.map((store) => {
        const device = deviceByStore.get(store.id);
        return {
          id: store.id,
          name: store.name,
          code: store.code,
          city: store.city,
          region: store.region,
          timezone: store.timezone,
          online: Boolean(store.online),
          device_connected: Boolean(device && device.status === 'connected'),
          device: device ? {
            id: device.id,
            name: device.name,
            status: device.status,
            audio_source: device.audio_source,
            version: device.version,
            last_heartbeat: device.last_heartbeat?.toISOString?.() || null,
            cpu_pct: device.cpu_pct,
            memory_pct: device.memory_pct,
            audio_status: device.audio_status,
            microphone_status: device.microphone_status,
            stream_status: device.stream_status,
            processing_latency_ms: device.processing_latency_ms,
          } : null,
          open_conversations: liveByStore.get(store.id) || 0,
          employees: employeeByStore.get(store.id) || 0,
        };
      });
      return response.json({ stores: {
        items: serialized.slice((page - 1) * pageSize, page * pageSize),
        total: serialized.length,
        page,
        page_size: pageSize,
      } });
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/stores/:storeId', authenticate, async (request, response, next) => {
    try {
      const filter = { id: request.params.storeId };
      if (request.user.role !== 'SUPER_ADMIN') filter.organization_id = request.user.organization_id;
      const store = await StoreModel.findOne(filter).lean();
      if (!store) return response.status(404).json({ detail: 'Store not found' });
      const [serialized] = await (async () => {
        const device = await DeviceModel?.findOne({ store_id: store.id, revoked: { $ne: true } }).lean();
        const [liveCount, employeeCount] = await Promise.all([
          ConversationModel?.countDocuments({ store_id: store.id, status: 'LIVE' }) || 0,
          EmployeeModel?.countDocuments({ store_id: store.id, active: true }) || 0,
        ]);
        return [{
          ...store,
          device_connected: Boolean(device && device.status === 'connected'),
          device: device || null,
          open_conversations: liveCount,
          employees: employeeCount,
        }];
      })();
      serialized.conversations = await ConversationModel.find({ store_id: store.id, ...await scopedStoreFilter(request.user) }).sort({ started_at: -1 }).lean();
      return response.json(serialized);
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/stores', authenticate, async (request, response, next) => {
    try {
      requireOrganizationAdmin(request.user);
      if (!request.user.organization_id) return response.status(400).json({ detail: 'User is not assigned to an organization' });
      const name = requiredText(request.body, 'name', 120);
      const code = requiredText(request.body, 'code', 32);
      const city = requiredText(request.body, 'city', 80);
      const region = requiredText(request.body, 'region', 40);
      const timezone = request.body.timezone === undefined ? 'America/Chicago' : requiredText(request.body, 'timezone', 64);
      const duplicate = await StoreModel.findOne({ organization_id: request.user.organization_id, code }).lean();
      if (duplicate) return response.status(409).json({ detail: 'A store with this code already exists in the organization' });
      const store = {
        id: `store-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        organization_id: request.user.organization_id,
        name,
        code,
        city,
        region,
        timezone,
        online: false,
      };
      await StoreModel.create(store);
      await writeAudit(request.user, 'store.created', 'store', store.id, code);
      return response.status(201).json({
        ...store,
        device_connected: false,
        device: null,
        open_conversations: 0,
        employees: 0,
      });
    } catch (error) { return next(error); }
  });

  app.patch('/api/v1/stores/:storeId', authenticate, async (request, response, next) => {
    try {
      requireOrganizationAdmin(request.user);
      const filter = { id: request.params.storeId };
      if (request.user.role !== 'SUPER_ADMIN') filter.organization_id = request.user.organization_id;
      const store = await StoreModel.findOne(filter);
      if (!store) return response.status(404).json({ detail: 'Store not found' });
      const fields = ['name', 'code', 'city', 'region', 'timezone'];
      const changes = {};
      for (const field of fields) {
        const value = optionalText(request.body, field, { name: 120, code: 32, city: 80, region: 40, timezone: 64 }[field]);
        if (value !== undefined) changes[field] = value;
      }
      if (!Object.keys(changes).length) return response.status(422).json({ detail: 'Provide at least one non-empty field to update' });
      if (changes.code) {
        const duplicate = await StoreModel.findOne({
          organization_id: store.organization_id,
          code: changes.code,
          id: { $ne: store.id },
        }).lean();
        if (duplicate) return response.status(409).json({ detail: 'A store with this code already exists in the organization' });
      }
      Object.assign(store, changes);
      await store.save();
      await writeAudit(request.user, 'store.updated', 'store', store.id, Object.keys(changes).join(','));
      return response.json({ ...store.toObject?.() || store, device_connected: false, device: null, open_conversations: 0, employees: 0 });
    } catch (error) { return next(error); }
  });

  app.delete('/api/v1/stores/:storeId', authenticate, async (request, response, next) => {
    try {
      requireOrganizationAdmin(request.user);
      const filter = { id: request.params.storeId };
      if (request.user.role !== 'SUPER_ADMIN') filter.organization_id = request.user.organization_id;
      const store = await StoreModel.findOne(filter).lean();
      if (!store) return response.status(404).json({ detail: 'Store not found' });
      if (await hasStoreReferences(store.id)) return response.status(409).json({ detail: 'Store has linked operational records and cannot be deleted' });
      await StoreModel.deleteOne({ id: store.id });
      await writeAudit(request.user, 'store.deleted', 'store', store.id, store.code || '');
      return response.json({ id: store.id, deleted: true });
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/inventory', authenticate, async (request, response, next) => {
    try {
      const scope = await scopedStoreFilter(request.user);
      if (request.query.store_id) {
        const store = await accessibleStore(String(request.query.store_id), { user: request.user });
        if (!store) return response.status(404).json({ detail: 'Store not found' });
        scope.store_id = store.id;
      }
      const items = await StockItemModel.find(scope).sort({ name: 1, sku: 1 }).lean();
      return response.json({
        items,
        summary: {
          items: items.length,
          units_on_hand: items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
          inventory_value: Number(items.reduce((sum, item) => sum + Number(item.cost || 0) * Number(item.quantity || 0), 0).toFixed(2)),
          low_stock: items.filter((item) => Number(item.quantity || 0) <= Number(item.par_level || 0)).length,
        },
      });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/inventory', authenticate, async (request, response, next) => {
    try {
      const storeId = requiredText(request.body, 'store_id', 64);
      requireStoreManager(request.user);
      const store = await accessibleStore(storeId, { user: request.user });
      if (!store) return response.status(404).json({ detail: 'Store not found' });
      const sku = requiredText(request.body, 'sku', 64).toUpperCase();
      const name = requiredText(request.body, 'name', 160);
      const cost = request.body.cost === undefined ? 0 : numericValue(request.body, 'cost');
      const price = request.body.price === undefined ? 0 : numericValue(request.body, 'price');
      const quantity = request.body.quantity === undefined ? 0 : numericValue(request.body, 'quantity', { integer: true });
      const parLevel = request.body.par_level === undefined ? 0 : numericValue(request.body, 'par_level', { integer: true });
      const duplicate = await StockItemModel.findOne({ store_id: store.id, sku }).lean();
      if (duplicate) return response.status(409).json({ detail: 'That SKU already exists in this store' });
      const item = {
        id: `stock-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        store_id: store.id,
        sku,
        name,
        cost,
        price,
        quantity,
        par_level: parLevel,
      };
      await StockItemModel.create(item);
      await writeAudit(request.user, 'stock.created', 'stock_item', item.id, sku);
      return response.status(201).json(serializeStockItem(item));
    } catch (error) { return next(error); }
  });

  app.patch('/api/v1/inventory/:itemId', authenticate, async (request, response, next) => {
    try {
      const item = await StockItemModel.findOne({ id: request.params.itemId, ...await scopedStoreFilter(request.user) });
      if (!item) return response.status(404).json({ detail: 'Stock item not found' });
      requireStoreManager(request.user);
      const changes = {};
      const sku = optionalText(request.body, 'sku', 64);
      const name = optionalText(request.body, 'name', 160);
      if (sku !== undefined) changes.sku = sku.toUpperCase();
      if (name !== undefined) changes.name = name;
      for (const field of ['cost', 'price']) {
        const value = numericValue(request.body, field, { optional: true });
        if (value !== undefined) changes[field] = value;
      }
      for (const field of ['quantity', 'par_level']) {
        const value = numericValue(request.body, field, { integer: true, optional: true });
        if (value !== undefined) changes[field] = value;
      }
      if (!Object.keys(changes).length) return response.status(422).json({ detail: 'Provide at least one non-empty field to update' });
      if (changes.sku) {
        const duplicate = await StockItemModel.findOne({ store_id: item.store_id, sku: changes.sku, id: { $ne: item.id } }).lean();
        if (duplicate) return response.status(409).json({ detail: 'That SKU already exists in this store' });
      }
      Object.assign(item, changes);
      await item.save();
      await writeAudit(request.user, 'stock.updated', 'stock_item', item.id, Object.keys(changes).join(','));
      return response.json(serializeStockItem(item));
    } catch (error) { return next(error); }
  });

  app.delete('/api/v1/inventory/:itemId', authenticate, async (request, response, next) => {
    try {
      const item = await StockItemModel.findOne({ id: request.params.itemId, ...await scopedStoreFilter(request.user) }).lean();
      if (!item) return response.status(404).json({ detail: 'Stock item not found' });
      requireStoreManager(request.user);
      await StockItemModel.deleteOne({ id: item.id });
      await writeAudit(request.user, 'stock.deleted', 'stock_item', item.id, item.sku);
      return response.status(204).end();
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/rules', authenticate, async (request, response, next) => {
    try {
      const scope = await scopedStoreFilter(request.user);
      if (request.query.store_id) {
        const store = await accessibleStore(String(request.query.store_id), { user: request.user });
        if (!store) return response.status(404).json({ detail: 'Store not found' });
        scope.store_id = store.id;
      }
      const rules = await StoreRuleModel.find(scope).sort({ created_at: -1, name: 1 }).lean();
      return response.json({ rules, active_count: rules.filter((rule) => rule.active).length });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/rules', authenticate, async (request, response, next) => {
    try {
      const storeId = requiredText(request.body, 'store_id', 64);
      requireStoreManager(request.user);
      const store = await accessibleStore(storeId, { user: request.user });
      if (!store) return response.status(404).json({ detail: 'Store not found' });
      const rule = {
        id: `rule-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        store_id: store.id,
        name: requiredText(request.body, 'name', 160),
        dollar_value: request.body.dollar_value === undefined ? 0 : numericValue(request.body, 'dollar_value'),
        trigger_condition: requiredText(request.body, 'trigger_condition', 2000),
        expected_action: requiredText(request.body, 'expected_action', 2000),
        active: true,
        created_at: new Date(),
      };
      await StoreRuleModel.create(rule);
      await writeAudit(request.user, 'rule.created', 'store_rule', rule.id, rule.name);
      return response.status(201).json(serializeStoreRule(rule));
    } catch (error) { return next(error); }
  });

  app.patch('/api/v1/rules/:ruleId', authenticate, async (request, response, next) => {
    try {
      const rule = await StoreRuleModel.findOne({ id: request.params.ruleId, ...await scopedStoreFilter(request.user) });
      if (!rule) return response.status(404).json({ detail: 'Rule not found' });
      requireStoreManager(request.user);
      const changes = {};
      for (const field of ['name', 'trigger_condition', 'expected_action']) {
        const limit = field === 'name' ? 160 : 2000;
        const value = optionalText(request.body, field, limit);
        if (value !== undefined) changes[field] = value;
      }
      const dollarValue = numericValue(request.body, 'dollar_value', { optional: true });
      if (dollarValue !== undefined) changes.dollar_value = dollarValue;
      if (request.body.active !== undefined) {
        if (typeof request.body.active !== 'boolean') return response.status(422).json({ detail: 'active must be a boolean' });
        changes.active = request.body.active;
      }
      if (!Object.keys(changes).length) return response.status(422).json({ detail: 'Provide at least one non-empty field to update' });
      Object.assign(rule, changes);
      await rule.save();
      await writeAudit(request.user, 'rule.updated', 'store_rule', rule.id, Object.keys(changes).join(','));
      return response.json(serializeStoreRule(rule));
    } catch (error) { return next(error); }
  });

  app.delete('/api/v1/rules/:ruleId', authenticate, async (request, response, next) => {
    try {
      const rule = await StoreRuleModel.findOne({ id: request.params.ruleId, ...await scopedStoreFilter(request.user) }).lean();
      if (!rule) return response.status(404).json({ detail: 'Rule not found' });
      requireStoreManager(request.user);
      await StoreRuleModel.deleteOne({ id: rule.id });
      await writeAudit(request.user, 'rule.deleted', 'store_rule', rule.id, rule.name);
      return response.status(204).end();
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/opportunities', authenticate, async (request, response, next) => {
    try {
      const scope = await scopedStoreFilter(request.user);
      const page = Math.max(1, Number.parseInt(request.query.page || '1', 10) || 1);
      const pageSize = Math.min(100, Math.max(1, Number.parseInt(request.query.page_size || '25', 10) || 25));
      const query = OpportunityModel.find(scope).sort({ created_at: -1 });
      const [items, total] = await Promise.all([
        query.skip((page - 1) * pageSize).limit(pageSize).lean(),
        OpportunityModel.countDocuments(scope),
      ]);
      return response.json({ opportunities: { items: items.map((item) => ({ ...item, product: item.product_name })), total, page, page_size: pageSize, pages: Math.ceil(total / pageSize) } });
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/analytics', authenticate, async (request, response, next) => {
    try {
      const ids = await visibleStoreIds(request.user);
      const storeFilter = ids === null ? {} : { id: { $in: ids } };
      const stores = await StoreModel.find(storeFilter).lean();
      if (!stores.length) {
        return response.json({
          metrics: {
            active_stores: 0,
            online_stores: 0,
            offline_stores: 0,
            live_conversations: 0,
            conversations_today: 0,
            total_conversations: 0,
            sales_opportunities: 0,
            converted_opportunities: 0,
            conversion_rate: 0,
            language_distribution: {},
            conversation_trend: Array(7).fill(0),
          },
          stores: [],
          store_performance: [],
          dataMode: config.demoMode ? 'demo' : 'live',
        });
      }
      const storeIds = stores.map((store) => store.id);
      const [conversations, opportunities] = await Promise.all([
        ConversationModel.find({ store_id: { $in: storeIds }, data_source: 'live' }).lean(),
        OpportunityModel.find({ store_id: { $in: storeIds } }).lean(),
      ]);
      const storeRows = stores.map((store) => {
        const storeConversations = conversations.filter((conversation) => conversation.store_id === store.id);
        const storeOpportunities = opportunities.filter((opportunity) => opportunity.store_id === store.id);
        const converted = storeOpportunities.filter((opportunity) => opportunity.status === 'CONVERTED').length;
        return {
          store_id: store.id,
          conversations: storeConversations.length,
          opportunities: storeOpportunities.length,
          converted,
          conversion_rate: storeOpportunities.length
            ? Number((converted / storeOpportunities.length).toFixed(2))
            : 0,
        };
      });
      const devices = await DeviceModel?.find({ store_id: { $in: storeIds }, revoked: { $ne: true } }).lean() || [];
      const employees = await EmployeeModel?.find({ store_id: { $in: storeIds }, active: { $ne: false } }).lean() || [];
      const deviceByStore = new Map();
      for (const device of devices) if (!deviceByStore.has(device.store_id)) deviceByStore.set(device.store_id, device);
      const visibleStores = stores.map((store) => {
        const device = deviceByStore.get(store.id);
        return {
          id: store.id,
          name: store.name,
          city: store.city || '',
          region: store.region || '',
          online: Boolean(device && device.status === 'connected'),
          device_connected: Boolean(device && device.status === 'connected'),
          open_conversations: conversations.filter((conversation) => conversation.store_id === store.id && conversation.status === 'LIVE').length,
          employees: employees.filter((employee) => employee.store_id === store.id).length,
        };
      });
      const totalConversations = conversations.length;
      const totalOpportunities = opportunities.length;
      const totalConverted = opportunities.filter((opportunity) => opportunity.status === 'CONVERTED').length;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const conversationTrend = Array.from({ length: 7 }, (_, index) => {
        const day = new Date(today.getTime() - (6 - index) * 86_400_000);
        return conversations.filter((conversation) => {
          if (!conversation.started_at) return false;
          const started = new Date(conversation.started_at);
          return started.getFullYear() === day.getFullYear()
            && started.getMonth() === day.getMonth()
            && started.getDate() === day.getDate();
        }).length;
      });
      const languageDistribution = {};
      for (const conversation of conversations) {
        const language = conversation.primary_language || 'und';
        languageDistribution[language] = (languageDistribution[language] || 0) + 1;
      }
      return response.json({
        metrics: {
          active_stores: stores.length,
          online_stores: visibleStores.filter((store) => store.online).length,
          offline_stores: visibleStores.filter((store) => !store.online).length,
          live_conversations: conversations.filter((conversation) => conversation.status === 'LIVE').length,
          conversations_today: conversations.filter((conversation) => conversation.started_at && new Date(conversation.started_at) >= today).length,
          total_conversations: totalConversations,
          sales_opportunities: totalOpportunities,
          converted_opportunities: totalConverted,
          conversion_rate: totalOpportunities ? Number((totalConverted / totalOpportunities).toFixed(2)) : 0,
          language_distribution: languageDistribution,
          conversation_trend: conversationTrend,
        },
        stores: visibleStores,
        store_performance: storeRows,
        dataMode: config.demoMode ? 'demo' : 'live',
      });
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/sales-intelligence', authenticate, async (request, response, next) => {
    try {
      const scope = await scopedStoreFilter(request.user);
      const recommendations = await SalesRecommendationModel.find(scope).sort({ created_at: -1 }).limit(100).lean();
      return response.json({ recommendations: recommendations.map((item) => ({
        id: item.id,
        conversation_id: item.conversation_id,
        store_id: item.store_id,
        title: item.title,
        message: item.message,
        confidence: item.confidence,
        label: 'AI-assisted recommendation',
      })) });
    } catch (error) { return next(error); }
  });

  function serializeEmployee(employee) {
    return {
      id: employee.id,
      name: employee.full_name,
      store_id: employee.store_id,
      role: employee.role_title || 'Sales associate',
      active: employee.active !== false,
    };
  }

  app.get('/api/v1/employees', authenticate, async (request, response, next) => {
    try {
      const scope = await scopedStoreFilter(request.user);
      if (request.query.store_id) {
        const store = await accessibleStore(String(request.query.store_id), { user: request.user });
        if (!store) return response.status(404).json({ detail: 'Store not found' });
        scope.store_id = store.id;
      }
      const employees = await EmployeeModel.find({ ...scope, active: true }).sort({ full_name: 1 }).lean();
      return response.json({ employees: employees.map(serializeEmployee), metrics_are_ai_assisted: true });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/employees', authenticate, async (request, response, next) => {
    try {
      const storeId = requiredText(request.body, 'store_id', 64);
      requireStoreManager(request.user);
      const store = await accessibleStore(storeId, { user: request.user });
      if (!store) return response.status(404).json({ detail: 'Store not found' });
      const employee = {
        id: `employee-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        store_id: store.id,
        full_name: requiredText(request.body, 'name', 160),
        role_title: request.body.role === undefined ? 'Sales associate' : requiredText(request.body, 'role', 80),
        active: true,
      };
      await EmployeeModel.create(employee);
      await writeAudit(request.user, 'employee.created', 'employee', employee.id, employee.store_id);
      return response.status(201).json(serializeEmployee(employee));
    } catch (error) { return next(error); }
  });

  app.patch('/api/v1/employees/:employeeId', authenticate, async (request, response, next) => {
    try {
      const employee = await EmployeeModel.findOne({
        id: request.params.employeeId,
        active: { $ne: false },
        ...await scopedStoreFilter(request.user),
      });
      if (!employee) return response.status(404).json({ detail: 'Employee not found' });
      requireStoreManager(request.user);
      const changes = {};
      const name = optionalText(request.body, 'name', 160);
      const role = optionalText(request.body, 'role', 80);
      const storeId = optionalText(request.body, 'store_id', 64);
      if (name !== undefined) changes.full_name = name;
      if (role !== undefined) changes.role_title = role;
      if (storeId !== undefined) {
        const store = await accessibleStore(storeId, { user: request.user });
        if (!store) return response.status(404).json({ detail: 'Store not found' });
        changes.store_id = store.id;
      }
      if (!Object.keys(changes).length) return response.status(422).json({ detail: 'Provide at least one non-empty field to update' });
      Object.assign(employee, changes);
      await employee.save();
      await writeAudit(request.user, 'employee.updated', 'employee', employee.id, 'employee profile');
      return response.json(serializeEmployee(employee));
    } catch (error) { return next(error); }
  });

  app.delete('/api/v1/employees/:employeeId', authenticate, async (request, response, next) => {
    try {
      const employee = await EmployeeModel.findOne({
        id: request.params.employeeId,
        active: { $ne: false },
        ...await scopedStoreFilter(request.user),
      });
      if (!employee) return response.status(404).json({ detail: 'Employee not found' });
      requireStoreManager(request.user);
      employee.active = false;
      await employee.save();
      await writeAudit(request.user, 'employee.deactivated', 'employee', employee.id, employee.store_id);
      return response.json({ id: employee.id, active: false });
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/employees/:employeeId', authenticate, async (request, response, next) => {
    try {
      const employee = await EmployeeModel.findOne({
        id: request.params.employeeId,
        ...await scopedStoreFilter(request.user),
      }).lean();
      if (!employee) return response.status(404).json({ detail: 'Employee not found' });
      return response.json(serializeEmployee(employee));
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/employees/:employeeId/performance', authenticate, async (request, response, next) => {
    try {
      const employee = await EmployeeModel.findOne({
        id: request.params.employeeId,
        ...await scopedStoreFilter(request.user),
      }).lean();
      if (!employee) return response.status(404).json({ detail: 'Employee not found' });
      const performance = await EmployeePerformanceModel?.findOne({ employee_id: employee.id }).lean() || null;
      return response.json({
        employeeId: employee.id,
        name: employee.full_name,
        storeId: employee.store_id,
        conversationsHandled: performance?.conversations_handled || 0,
        opportunitiesDetected: performance?.opportunities_detected || 0,
        opportunitiesConverted: performance?.opportunities_converted || 0,
        potentialMissed: performance?.potential_missed || 0,
        conversionRate: performance?.conversion_rate || 0,
        averageResponseTimeSeconds: performance?.avg_response_seconds || 0,
        aiAssistedMetric: true,
        caveat: 'AI-assisted metrics. Not an objective performance score.',
      });
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/pos/transactions', authenticate, async (request, response, next) => {
    try {
      const filter = await scopedStoreFilter(request.user);
      if (request.query.store_id) {
        const store = await accessibleStore(String(request.query.store_id), { user: request.user });
        if (!store) return response.status(404).json({ detail: 'Store not found' });
        filter.store_id = store.id;
      }
      const transactions = await PosTransactionModel.find(filter).sort({ occurred_at: -1 }).lean();
      const items = await Promise.all(transactions.map(async (transaction) => {
        const line = await PosTransactionItemModel?.findOne({ transaction_id: transaction.id }).lean() || null;
        return {
          id: transaction.id,
          store_id: transaction.store_id,
          employee_id: transaction.employee_id || null,
          product: line?.name || 'Item',
          amount: transaction.amount,
          currency: transaction.currency || 'USD',
          created_at: transaction.occurred_at?.toISOString?.() || null,
          provider: transaction.provider,
        };
      }));
      return response.json({ transactions: items, provider: config.posProvider, dataMode: config.demoMode ? 'demo' : 'live' });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/pos/demo', authenticate, async (request, response, next) => {
    try {
      if (!config.demoMode || config.posProvider !== 'mock') {
        return response.status(409).json({ detail: 'POS demo sales are available only in demo mode with the Mock POS provider.' });
      }
      requireStoreManager(request.user);
      const storeIds = await visibleStoreIds(request.user);
      const store = request.user.store_id
        ? await accessibleStore(request.user.store_id, { user: request.user })
        : (await StoreModel.find(storeIds === null ? {} : { id: { $in: storeIds } }).sort({ name: 1 }).limit(1).lean())[0] || null;
      if (!store) return response.status(409).json({ detail: 'No accessible store is available for the POS demo.' });
      const transaction = {
        id: `pos-demo-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        store_id: store.id,
        amount: 19.99,
        currency: 'USD',
        occurred_at: new Date(),
        provider: 'mock',
      };
      await PosTransactionModel.create(transaction);
      await PosTransactionItemModel?.create({
        id: `pos-demo-item-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        transaction_id: transaction.id,
        sku: 'DEMO-USB-C',
        name: 'USB-C Charger',
        unit_price: transaction.amount,
      });
      await writeAudit(request.user, 'pos.demo_sale', 'pos_transaction', transaction.id, `store_id=${store.id}`);
      return response.status(201).json({
        transaction: { id: transaction.id, product: 'USB-C Charger', amount: transaction.amount, store_id: store.id },
        match: null,
        provider: 'mock',
        dataMode: 'demo',
      });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/pos/webhook', authenticate, async (request, response, next) => {
    try {
      if (config.posProvider === 'none') {
        return response.status(503).json({ detail: 'No POS integration is configured. Configure a live POS provider before sending transactions.' });
      }
      const storeId = requiredText(request.body, 'store_id', 64);
      const sku = requiredText(request.body, 'sku', 64);
      const name = requiredText(request.body, 'name', 160);
      const amount = numericValue(request.body, 'amount');
      const employeeId = request.body.employee_id === undefined || request.body.employee_id === null
        ? null
        : requiredText(request.body, 'employee_id', 64);
      const store = await accessibleStore(storeId, { user: request.user });
      if (!store) return response.status(404).json({ detail: 'Store not found' });
      const transaction = {
        id: `pos-webhook-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        store_id: store.id,
        employee_id: employeeId,
        amount,
        currency: 'USD',
        occurred_at: new Date(),
        provider: config.posProvider,
      };
      await PosTransactionModel.create(transaction);
      await PosTransactionItemModel?.create({
        id: `pos-webhook-item-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        transaction_id: transaction.id,
        sku,
        name,
        unit_price: amount,
      });
      await writeAudit(request.user, 'pos.webhook.accepted', 'pos_transaction', transaction.id, `store_id=${store.id}`);
      return response.json({ accepted: true, transaction_id: transaction.id, matched: false });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/demo/replay', authenticate, async (request, response, next) => {
    try {
      if (!config.demoMode) return response.status(409).json({ detail: 'Demo replay is disabled outside demo mode.' });
      const storeId = request.body?.store_id ? requiredText(request.body, 'store_id', 64) : 'store-001';
      const store = await accessibleStore(storeId, { user: request.user });
      if (!store) return response.status(404).json({ detail: 'Store not found' });
      const conversationId = `conv-demo-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const startedAt = new Date();
      const customerText = '¿Tiene un cargador para iPhone?';
      const englishCustomerText = 'Do you have an iPhone charger?';
      const employeeText = 'Yes — USB-C or Lightning? What iPhone do you have?';
      await ConversationModel.create({
        id: conversationId,
        store_id: store.id,
        data_source: 'demo',
        employee_id: null,
        status: 'LIVE',
        primary_language: 'es',
        started_at: startedAt,
        ended_at: null,
        customer_intent: null,
        detected_product: null,
        opportunity_status: 'UNKNOWN',
      });
      await ParticipantModel?.create({
        id: `participant-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        conversation_id: conversationId,
        speaker_label: 'Customer',
        mapped_role: 'customer',
      });
      await ParticipantModel?.create({
        id: `participant-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        conversation_id: conversationId,
        speaker_label: 'Representative',
        mapped_role: 'employee',
      });

      const publishDemoEvent = (event, payload = {}) => {
        sockets?.publish?.(`store:${store.id}`, {
          event,
          timestamp: new Date().toISOString(),
          storeId: store.id,
          conversationId,
          ...payload,
        });
      };
      const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const replay = async () => {
        try {
          publishDemoEvent('device.health.updated', { status: 'connected', audioStatus: 'streaming' });
          publishDemoEvent('conversation.started');
          publishDemoEvent('transcript.partial', {
            segmentId: `segment-${conversationId}-1`,
            speakerId: 'speaker-customer',
            language: 'es',
            originalText: customerText,
            englishText: englishCustomerText,
            confidence: 0.92,
            isFinal: false,
          });
          await pause(500);
          await TranscriptSegmentModel.create({
            id: `segment-${conversationId}-1`,
            conversation_id: conversationId,
            speaker_id: 'speaker-customer',
            language: 'es',
            original_text: customerText,
            translated_text: englishCustomerText,
            start_time: 0,
            end_time: 2.9,
            confidence: 0.96,
            is_final: true,
            created_at: new Date(),
          });
          publishDemoEvent('transcript.final', {
            segmentId: `segment-${conversationId}-1`,
            speakerId: 'speaker-customer',
            speakerLabel: 'Customer',
            language: 'es',
            originalText: customerText,
            englishText: englishCustomerText,
            confidence: 0.96,
            isFinal: true,
          });
          publishDemoEvent('intent.detected', { intent: 'charger purchase', product: 'phone charger', confidence: 0.89 });
          const opportunity = {
            id: `opportunity-${conversationId}`,
            conversation_id: conversationId,
            store_id: store.id,
            customer_intent: 'charger purchase',
            product_name: 'phone charger',
            status: 'OPEN',
            confidence: 0.89,
            recommendation: 'Ask which iPhone model or connector the customer uses.',
            created_at: new Date(),
          };
          await OpportunityModel.create(opportunity);
          await SalesRecommendationModel?.create({
            id: `recommendation-${conversationId}`,
            conversation_id: conversationId,
            store_id: store.id,
            title: 'Connector clarification',
            message: opportunity.recommendation,
            confidence: opportunity.confidence,
            created_at: new Date(),
          });
          publishDemoEvent('opportunity.detected', {
            opportunityId: opportunity.id,
            status: opportunity.status,
            product: opportunity.product_name,
            confidence: opportunity.confidence,
            label: 'Potential Opportunity',
          });
          publishDemoEvent('sales_tip.generated', { message: opportunity.recommendation, confidence: opportunity.confidence });
          await pause(500);
          await TranscriptSegmentModel.create({
            id: `segment-${conversationId}-2`,
            conversation_id: conversationId,
            speaker_id: 'speaker-demo-employee',
            language: 'en',
            original_text: employeeText,
            translated_text: employeeText,
            start_time: 3.4,
            end_time: 6,
            confidence: 0.94,
            is_final: true,
            created_at: new Date(),
          });
          publishDemoEvent('transcript.final', {
            segmentId: `segment-${conversationId}-2`,
            speakerId: 'speaker-demo-employee',
            speakerLabel: 'Representative',
            language: 'en',
            originalText: employeeText,
            englishText: employeeText,
            confidence: 0.94,
            isFinal: true,
          });
          const endedAt = new Date();
          await ConversationModel.updateOne({ id: conversationId }, {
            $set: { status: 'ENDED', ended_at: endedAt, opportunity_status: 'OPEN' },
          });
          publishDemoEvent('conversation.ended', { opportunityStatus: 'OPEN' });
        } catch (error) {
          console.error(`Demo replay failed for conversation ${conversationId}:`, error);
        }
      };
      setTimeout(() => void replay(), 0);
      return response.json({ status: 'started', store_id: store.id, scenario: 'spanish_iphone_charger' });
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/settings', authenticate, async (request, response, next) => {
    try {
      const storeScope = await scopedStoreFilter(request.user);
      const [stores, devices, integrations, users] = await Promise.all([
        StoreModel.find(request.user.role === 'SUPER_ADMIN' ? {} : { organization_id: request.user.organization_id }).sort({ name: 1 }).lean(),
        DeviceModel.find({ ...storeScope, revoked: { $ne: true } }).lean(),
        IntegrationConnectionModel?.find({}).lean() || [],
        UserModel.find(request.user.role === 'SUPER_ADMIN'
          ? {}
          : request.user.role === 'ORG_ADMIN'
            ? { organization_id: request.user.organization_id }
            : { id: request.user.id }).lean(),
      ]);
      const storeIds = stores.map((store) => store.id);
      const [liveConversations, employees] = await Promise.all([
        ConversationModel.find({ store_id: { $in: storeIds }, status: 'LIVE' }).lean(),
        EmployeeModel.find({ store_id: { $in: storeIds }, active: true }).lean(),
      ]);
      const devicesByStore = new Map();
      for (const device of devices) if (!devicesByStore.has(device.store_id)) devicesByStore.set(device.store_id, device);
      const liveByStore = new Map();
      for (const row of liveConversations) liveByStore.set(row.store_id, (liveByStore.get(row.store_id) || 0) + 1);
      const employeeByStore = new Map();
      for (const row of employees) employeeByStore.set(row.store_id, (employeeByStore.get(row.store_id) || 0) + 1);
      const storeSummaries = stores.map((store) => {
        const device = devicesByStore.get(store.id);
        return {
          id: store.id,
          name: store.name,
          code: store.code,
          city: store.city,
          region: store.region,
          timezone: store.timezone,
          online: Boolean(store.online),
          device_connected: Boolean(device && device.status === 'connected'),
          device: device || null,
          open_conversations: liveByStore.get(store.id) || 0,
          employees: employeeByStore.get(store.id) || 0,
        };
      });
      return response.json({
        demo_mode: config.demoMode,
        providers: {
          ai: config.aiProvider,
          speech: config.speechProvider,
          pos: config.posProvider,
          storage: config.storageProvider,
        },
        retention: {
          audio_days: config.audioRetentionDays,
          transcript_days: config.transcriptRetentionDays,
          raw_audio_stored_by_default: false,
        },
        stores: storeSummaries,
        devices: devices.map((device) => ({
          id: device.id,
          store_id: device.store_id,
          status: device.status,
          audio_source: device.audio_source,
          version: device.version,
          cpu_pct: device.cpu_pct,
          memory_pct: device.memory_pct,
          audio_status: device.audio_status,
          microphone_status: device.microphone_status,
          stream_status: device.stream_status,
        })),
        roles: ['SUPER_ADMIN', 'ORG_ADMIN', 'STORE_MANAGER', 'SUPERVISOR', 'EMPLOYEE', 'VIEWER'],
        users: users.map((user) => ({
          id: user.id,
          email: user.email,
          full_name: user.full_name,
          role: user.role,
          store_id: user.store_id || null,
        })),
        integrations: integrations.map((integration) => ({
          kind: integration.kind,
          provider: integration.provider,
          status: integration.status,
          notes: integration.notes,
        })),
        ai: {
          provider: 'rules',
          conversation_report_provider: config.groqApiKey ? 'groq' : 'unavailable',
          live_coaching_provider: config.groqApiKey ? 'groq' : 'unavailable',
          daily_report_provider: config.groqApiKey ? 'groq' : 'unavailable',
          speech_provider: config.speechProvider,
          supports_original_transcript: true,
          supports_english_translation: Boolean(config.deeplApiKey || config.groqApiKey),
          provider_note: 'Conversation reports, live coaching, and daily report summaries use Groq. Live opportunity signals remain deterministic local rules. Deepgram handles speech transcription; Spanish-to-English uses DeepL when configured and otherwise falls back to Groq.',
        },
        security: {
          authentication: 'jwt+httpOnly-cookie',
          rbac: 'enabled',
          websocket_authentication: 'token-query',
          secrets_exposed: false,
        },
      });
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/devcore/tasks', authenticate, async (request, response, next) => {
    try {
      if (!['SUPER_ADMIN', 'ORG_ADMIN'].includes(request.user.role)) {
        return response.status(403).json({ detail: 'Devcore workspace requires an organization administrator' });
      }
      const tasks = await DevcoreTaskModel.find({}).sort({ sort_order: 1 }).lean();
      return response.json({ tasks: tasks.map((task) => ({
        id: task.id,
        project_id: task.project_id,
        title: task.title,
        description: task.description || '',
        status: task.status,
        priority: task.priority,
        assignee: task.assignee || '',
        due_date: task.due_date || null,
        labels: task.labels || '',
      })) });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/devcore/tasks', authenticate, async (request, response, next) => {
    try {
      if (!['SUPER_ADMIN', 'ORG_ADMIN'].includes(request.user.role)) {
        return response.status(403).json({ detail: 'Devcore workspace requires an organization administrator' });
      }
      const task = {
        id: `task-${randomUUID().replaceAll('-', '').slice(0, 8)}`,
        project_id: request.body.project_id || 'proj-storelisten',
        title: requiredText(request.body, 'title', 200),
        description: String(request.body.description || ''),
        status: request.body.status || 'todo',
        priority: request.body.priority || 'medium',
        assignee: String(request.body.assignee || ''),
        due_date: request.body.due_date || null,
        labels: String(request.body.labels || ''),
      };
      await DevcoreTaskModel.create(task);
      return response.status(201).json(task);
    } catch (error) { return next(error); }
  });

  app.patch('/api/v1/devcore/tasks/:taskId', authenticate, async (request, response, next) => {
    try {
      if (!['SUPER_ADMIN', 'ORG_ADMIN'].includes(request.user.role)) {
        return response.status(403).json({ detail: 'Devcore workspace requires an organization administrator' });
      }
      const task = await DevcoreTaskModel.findOne({ id: request.params.taskId });
      if (!task) return response.status(404).json({ detail: 'Task not found' });
      const allowedFields = ['status', 'title', 'priority', 'assignee', 'due_date', 'labels'];
      const changes = Object.fromEntries(Object.entries(request.body || {}).filter(([field]) => allowedFields.includes(field)));
      if (!Object.keys(changes).length) return response.status(422).json({ detail: 'Provide at least one task field to update' });
      if (changes.status !== undefined && !['backlog', 'todo', 'in_progress', 'review', 'done'].includes(changes.status)) {
        return response.status(422).json({ detail: 'Invalid task status' });
      }
      if (changes.title !== undefined && (typeof changes.title !== 'string' || !changes.title.trim() || changes.title.length > 200)) {
        return response.status(422).json({ detail: 'Invalid task title' });
      }
      Object.assign(task, changes);
      await task.save();
      return response.json({ id: task.id, status: task.status, title: task.title });
    } catch (error) { return next(error); }
  });

  app.patch('/api/v1/opportunities/:opportunityId', authenticate, async (request, response, next) => {
    try {
      if (!['SUPER_ADMIN', 'ORG_ADMIN', 'STORE_MANAGER', 'SUPERVISOR'].includes(request.user.role)) {
        return response.status(403).json({ detail: 'Review requires a manager role' });
      }
      const opportunity = await OpportunityModel.findOne({
        id: request.params.opportunityId,
        ...await scopedStoreFilter(request.user),
      });
      if (!opportunity) return response.status(404).json({ detail: 'Opportunity not found' });
      const statuses = ['OPEN', 'CONVERTED', 'MISSED', 'UNKNOWN', 'REVIEW_REQUIRED'];
      if (!statuses.includes(request.body?.status)) return response.status(422).json({ detail: 'Invalid opportunity status' });
      const note = request.body.manager_note;
      if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 500)) {
        return response.status(422).json({ detail: 'manager_note must be at most 500 characters' });
      }
      opportunity.status = request.body.status;
      opportunity.manager_note = note ?? null;
      opportunity.reviewed_at = new Date();
      await opportunity.save();
      await writeAudit(request.user, 'opportunity.review', 'opportunity', opportunity.id, opportunity.status);
      return response.json({
        id: opportunity.id,
        conversation_id: opportunity.conversation_id,
        store_id: opportunity.store_id,
        employee_id: opportunity.employee_id || null,
        customer_intent: opportunity.customer_intent,
        product: opportunity.product_name,
        status: opportunity.status,
        confidence: opportunity.confidence,
        recommendation: opportunity.recommendation,
        manager_note: opportunity.manager_note,
        reviewed_at: opportunity.reviewed_at,
        created_at: opportunity.created_at,
      });
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/alerts', authenticate, async (request, response, next) => {
    try {
      const scope = await scopedStoreFilter(request.user);
      const alerts = await AlertModel.find({ ...scope, acknowledged: { $ne: true } }).sort({ created_at: -1 }).limit(100).lean();
      return response.json({ alerts });
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/conversations', authenticate, async (request, response, next) => {
    try {
      const filter = await scopedStoreFilter(request.user);
      if (request.query.store_id) {
        const store = await accessibleStore(String(request.query.store_id), { user: request.user });
        if (!store) return response.status(404).json({ detail: 'Store not found' });
        filter.store_id = store.id;
      }
      if (request.query.status) filter.status = String(request.query.status);
      if (request.query.language) filter.primary_language = String(request.query.language);
      const page = Math.max(1, Number.parseInt(request.query.page || '1', 10) || 1);
      const pageSize = Math.min(100, Math.max(1, Number.parseInt(request.query.page_size || '25', 10) || 25));
      const [rows, total] = await Promise.all([
        ConversationModel.find(filter).sort({ started_at: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
        ConversationModel.countDocuments(filter),
      ]);
      return response.json({ conversations: {
        items: await serializeConversationRows(rows),
        total,
        page,
        page_size: pageSize,
        pages: Math.ceil(total / pageSize),
      } });
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/conversations/:conversationId', authenticate, async (request, response, next) => {
    try {
      const filter = { id: request.params.conversationId, ...await scopedStoreFilter(request.user) };
      const item = await ConversationModel.findOne(filter).lean();
      if (!item) return response.status(404).json({ detail: 'Conversation not found' });
      const [serialized] = await serializeConversationRows([item]);
      const [opportunities, recommendations, runs] = await Promise.all([
        OpportunityModel?.find({ conversation_id: item.id }).lean() || [],
        SalesRecommendationModel?.find({ conversation_id: item.id }).lean() || [],
        AiProcessingRunModel?.find({ conversation_id: item.id }).lean() || [],
      ]);
      let conversationReport = null;
      for (const run of [...runs].sort((left, right) => new Date(right.created_at || 0) - new Date(left.created_at || 0))) {
        if (run.provider !== 'groq'
          || !String(run.input_excerpt || '').startsWith('[conversation-report]')
          || run.status !== 'completed') continue;
        try {
          const output = JSON.parse(run.output_json || '{}');
          if (output.kind === 'conversation_report' && output.report && typeof output.report === 'object') {
            conversationReport = output.report;
            break;
          }
        } catch { continue; }
      }
      const analyzed = opportunities.length || recommendations.length || runs.some((run) => run.status === 'completed');
      return response.json({
        ...serialized,
        data_source: item.data_source || 'live',
        analysis_status: analyzed ? 'analyzed' : runs.length ? 'unavailable' : 'pending',
        analysis_run_count: runs.length,
        opportunities: opportunities.map((row) => ({
          id: row.id,
          customer_intent: row.customer_intent,
          product: row.product_name,
          status: row.status,
          confidence: row.confidence,
          recommendation: row.recommendation,
          manager_note: row.manager_note || null,
        })),
        recommendations: recommendations.map((row) => ({ id: row.id, title: row.title, message: row.message, confidence: row.confidence })),
        conversation_report: conversationReport,
      });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/conversations/:conversationId/analysis', authenticate, async (request, response, next) => {
    try {
      const conversation = await ConversationModel.findOne({
        id: request.params.conversationId,
        ...await scopedStoreFilter(request.user),
      }).lean();
      if (!conversation) return response.status(404).json({ detail: 'Conversation not found' });
      const segments = await TranscriptSegmentModel.find({ conversation_id: conversation.id }).sort({ start_time: 1 }).lean();
      if (!segments.length) return response.status(409).json({ detail: 'No transcript is available to analyze.' });
      const transcript = segments.map((segment) => ({
        language: segment.language || 'und',
        role: segment.speaker_id === 'speaker-customer'
          ? 'customer'
          : String(segment.speaker_id || '').startsWith('speaker-employee-') ? 'employee' : 'unknown',
        text: englishTranscriptText(segment),
      })).filter((segment) => segment.text);
      if (!transcript.length) return response.status(409).json({ detail: 'No English transcript is ready for analysis yet.' });
      const output = analyzeConversation(transcript);
      const opportunities = output.opportunities;
      const recommendations = output.recommendations;
      const intents = output.intents;
      const provider = 'rules';
      const createdOpportunities = [];
      for (const item of opportunities) {
        if (!item || typeof item !== 'object') continue;
        const status = ['OPEN', 'CONVERTED', 'MISSED', 'UNKNOWN', 'REVIEW_REQUIRED'].includes(item.status) ? item.status : 'REVIEW_REQUIRED';
        const row = {
          id: `opportunity-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
          conversation_id: conversation.id,
          store_id: conversation.store_id,
          employee_id: conversation.employee_id || null,
          customer_intent: String(item.customer_intent || 'Unknown').slice(0, 160),
          product_name: String(item.product_name || 'Unknown').slice(0, 160),
          status,
          confidence: Math.min(1, Math.max(0, Number(item.confidence) || 0)),
          recommendation: String(item.recommendation || '').slice(0, 2000),
          manager_note: null,
          created_at: new Date(),
        };
        await OpportunityModel.create(row);
        createdOpportunities.push(row);
      }
      const createdRecommendations = [];
      for (const item of recommendations) {
        if (!item || typeof item !== 'object') continue;
        const row = {
          id: `recommendation-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
          conversation_id: conversation.id,
          store_id: conversation.store_id,
          title: String(item.title || 'Manager review').slice(0, 160),
          message: String(item.message || '').slice(0, 2000),
          confidence: Math.min(1, Math.max(0, Number(item.confidence) || 0)),
          created_at: new Date(),
        };
        await SalesRecommendationModel.create(row);
        createdRecommendations.push(row);
      }
      for (const item of intents) {
        if (!item || typeof item !== 'object' || !String(item.intent || '').trim()) continue;
        await CustomerIntentModel?.create({
          id: `intent-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
          conversation_id: conversation.id,
          intent: String(item.intent).slice(0, 120),
          product: String(item.product || '').slice(0, 160) || null,
          confidence: Math.min(1, Math.max(0, Number(item.confidence) || 0)),
          source: provider,
        });
      }
      const completedAt = new Date();
      await AiProcessingRunModel.create({
        id: `analysis-${randomUUID().replaceAll('-', '').slice(0, 16)}`,
        conversation_id: conversation.id,
        provider,
        status: 'completed',
        input_excerpt: '[conversation-analysis] ' + transcript.map((row) => row.text).join(' ').slice(0, 280),
        output_json: JSON.stringify({ kind: 'conversation_analysis', summary: output.report.summary }),
        created_at: completedAt,
      });
      await ConversationModel.updateOne({
        id: conversation.id,
      }, {
        $set: {
          customer_intent: createdOpportunities[0]?.customer_intent || null,
          detected_product: createdOpportunities[0]?.product_name || null,
          opportunity_status: createdOpportunities[0]?.status || 'UNKNOWN',
        },
      });
      await writeAudit(request.user, 'conversation.analysis', 'conversation', conversation.id, `provider=${provider};segments=${segments.length}`);
      return response.json({
        conversation_id: conversation.id,
        analysis_status: 'analyzed',
        processed_segments: segments.length,
        total_segments: segments.length,
        opportunities: createdOpportunities.map((item) => ({
          id: item.id,
          conversation_id: item.conversation_id,
          store_id: item.store_id,
          customer_intent: item.customer_intent,
          product: item.product_name,
          status: item.status,
          confidence: item.confidence,
          recommendation: item.recommendation,
        })),
        recommendations: createdRecommendations.map(({ id, title, message, confidence }) => ({ id, title, message, confidence })),
        caveat: 'Rule-based phrase matches are limited signals for human review, not proof of customer intent, sale outcome, or employee performance.',
      });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/conversations/:conversationId/report', authenticate, async (request, response, next) => {
    try {
      const conversation = await ConversationModel.findOne({
        id: request.params.conversationId,
        ...await scopedStoreFilter(request.user),
      }).lean();
      if (!conversation) return response.status(404).json({ detail: 'Conversation not found' });
      const segments = await TranscriptSegmentModel.find({ conversation_id: conversation.id }).sort({ start_time: 1 }).lean();
      if (!segments.length) return response.status(409).json({ detail: 'This conversation has no retained transcript to analyze.' });
      const transcript = segments.map((segment) => ({
        role: segment.speaker_id === 'speaker-customer' ? 'customer' : segment.speaker_id?.startsWith('speaker-employee-') ? 'employee' : 'unknown',
        language: segment.language || 'und',
        time_seconds: Number(segment.start_time) || 0,
        text: englishTranscriptText(segment) || String(segment.original_text || '').trim(),
      })).filter((segment) => segment.text);
      if (!transcript.length) return response.status(409).json({ detail: 'No readable transcript is ready for report generation yet.' });
      if (!config.groqApiKey) return response.status(503).json({ detail: 'AI conversation reports are not configured. Set GROQ_API_KEY on the backend service.' });
      const recordedOutcomes = await OpportunityModel?.find({ conversation_id: conversation.id }).lean() || [];
      const report = await groqConversationReport({
        apiKey: config.groqApiKey,
        model: config.groqModel,
        transcript,
        recordedOutcomes,
      });
      const provider = 'groq';
      const reportId = `report-${conversation.id}`;
      const prior = await AiProcessingRunModel.findOne({ id: reportId });
      Object.assign(prior || {}, {
        id: reportId,
        conversation_id: conversation.id,
        provider,
        status: 'completed',
        input_excerpt: '[conversation-report] ' + transcript.map((item) => item.text).join(' ').slice(0, 280),
        output_json: JSON.stringify({ kind: 'conversation_report', report }),
        created_at: new Date(),
      });
      if (prior) await prior.save();
      else await AiProcessingRunModel.create({
        id: reportId,
        conversation_id: conversation.id,
        provider,
        status: 'completed',
        input_excerpt: '[conversation-report] ' + transcript.map((item) => item.text).join(' ').slice(0, 280),
        output_json: JSON.stringify({ kind: 'conversation_report', report }),
        created_at: new Date(),
      });
      await writeAudit(request.user, 'conversation.report.generate', 'conversation_report', conversation.id, `provider=${provider};segments=${segments.length}`);
      return response.json({
        conversation_id: conversation.id,
        analysis_status: 'analyzed',
        report,
        transcript_generated: false,
        transcript_segments: segments.length,
        provider,
        caveat: 'Groq AI generated this transcript-grounded report. Findings are estimates for human review, not proof of a sale outcome or employee performance.',
      });
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/conversations/:conversationId/transcript', authenticate, async (request, response, next) => {
    try {
      const filter = { id: request.params.conversationId, ...await scopedStoreFilter(request.user) };
      const conversation = await ConversationModel.findOne(filter).lean();
      if (!conversation) return response.status(404).json({ detail: 'Transcript not found' });
      const segmentFilter = { conversation_id: conversation.id };
      const page = Math.max(1, Number.parseInt(request.query.page || '1', 10) || 1);
      const pageSize = Math.min(500, Math.max(1, Number.parseInt(request.query.page_size || '100', 10) || 100));
      const [segments, total, participants] = await Promise.all([
        TranscriptSegmentModel.find(segmentFilter).sort({ start_time: 1, created_at: 1, id: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
        TranscriptSegmentModel.countDocuments(segmentFilter),
        ParticipantModel?.find(segmentFilter).lean() || [],
      ]);
      await repairMissingTranslations(segments);
      const speakerDetails = new Map();
      for (const participant of participants) {
        const speakerId = participant.mapped_role === 'customer'
          ? 'speaker-customer'
          : participant.employee_id ? `speaker-${participant.employee_id}` : participant.speaker_label;
        speakerDetails.set(speakerId, {
          speaker_label: participant.speaker_label,
          speaker_role: participant.mapped_role || 'unknown',
          employee_id: participant.employee_id || null,
        });
      }
      return response.json({
        conversation_id: conversation.id,
        total,
        page,
        page_size: pageSize,
        segments: segments.map((row) => ({
          id: row.id,
          speaker_id: row.speaker_id,
          ...(speakerDetails.get(row.speaker_id) || { speaker_label: 'Speaker (unassigned)', speaker_role: 'unknown', employee_id: null }),
          language: row.language || 'und',
          original_text: row.original_text,
          translated_text: row.translated_text || null,
          english_text: row.translated_text || (row.language === 'en' ? row.original_text : 'English translation unavailable'),
          start_time: row.start_time || 0,
          end_time: row.end_time || 0,
          confidence: row.confidence || 0,
          is_final: row.is_final !== false,
        })),
      });
    } catch (error) { return next(error); }
  });

  app.patch('/api/v1/conversations/:conversationId/transcript/:segmentId/speaker', authenticate, async (request, response, next) => {
    try {
      const conversation = await ConversationModel.findOne({
        id: request.params.conversationId,
        ...await scopedStoreFilter(request.user),
      }).lean();
      if (!conversation) return response.status(404).json({ detail: 'Transcript not found' });
      const segment = await TranscriptSegmentModel.findOne({
        id: request.params.segmentId,
        conversation_id: conversation.id,
      });
      if (!segment) return response.status(404).json({ detail: 'Transcript segment not found' });
      const [completedAnalysis, opportunity, recommendation] = await Promise.all([
        AiProcessingRunModel.findOne({ conversation_id: conversation.id, status: 'completed' }).lean(),
        OpportunityModel.findOne({ conversation_id: conversation.id }).lean(),
        SalesRecommendationModel.findOne({ conversation_id: conversation.id }).lean(),
      ]);
      if (completedAnalysis || opportunity || recommendation) {
        return response.status(409).json({ detail: 'Speaker attribution cannot be changed after analysis is complete.' });
      }
      const speakerRole = request.body?.speaker_role;
      if (!['customer', 'employee', 'unknown'].includes(speakerRole)) {
        return response.status(422).json({ detail: 'speaker_role must be customer, employee, or unknown' });
      }
      if (speakerRole === 'unknown') {
        segment.speaker_id = 'speaker-unknown';
        await segment.save();
        return response.json({
          segment_id: segment.id,
          speaker_id: segment.speaker_id,
          speaker_label: 'Speaker (unassigned)',
          speaker_role: 'unknown',
          employee_id: null,
        });
      }
      let participant = await ParticipantModel.findOne({
        conversation_id: conversation.id,
        mapped_role: speakerRole,
        employee_id: null,
      });
      if (!participant) {
        participant = {
          id: `participant-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
          conversation_id: conversation.id,
          speaker_label: speakerRole === 'customer' ? 'Customer (operator selected)' : 'Representative (operator selected)',
          mapped_role: speakerRole,
          employee_id: null,
        };
        await ParticipantModel.create(participant);
      }
      segment.speaker_id = speakerRole === 'customer' ? 'speaker-customer' : participant.speaker_label;
      await segment.save();
      return response.json({
        segment_id: segment.id,
        speaker_id: segment.speaker_id,
        speaker_label: participant.speaker_label,
        speaker_role: participant.mapped_role,
        employee_id: participant.employee_id || null,
      });
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/conversations/:conversationId/audio', authenticate, async (request, response, next) => {
    try {
      const filter = { conversation_id: request.params.conversationId, ...await scopedStoreFilter(request.user) };
      const conversation = await ConversationModel.findOne({ id: request.params.conversationId, ...await scopedStoreFilter(request.user) }).lean();
      if (!conversation) return response.status(404).json({ detail: 'Conversation not found' });
      const page = Math.max(1, Number.parseInt(request.query.page || '1', 10) || 1);
      const pageSize = Math.min(100, Math.max(1, Number.parseInt(request.query.page_size || '20', 10) || 20));
      const [rows, total] = await Promise.all([
        AudioRecordingModel.find(filter).sort({ is_aggregate: -1, captured_at: -1, sequence: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
        AudioRecordingModel.countDocuments(filter),
      ]);
      return response.json({ total, page, page_size: pageSize, recordings: rows.map(({ id, captured_at, duration_seconds, byte_size, sequence, content_type, retain_until, is_aggregate }) => ({
        id, captured_at, duration_seconds, byte_size, sequence, content_type, retain_until,
        is_aggregate: Boolean(is_aggregate),
        playback_path: `/api/v1/audio/recordings/${id}`,
      })) });
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/audio/recordings/:recordingId', authenticate, async (request, response, next) => {
    try {
      const scope = await scopedStoreFilter(request.user);
      const row = await AudioRecordingModel.findOne({ id: request.params.recordingId, ...scope }).lean();
      if (!row || new Date(row.retain_until) <= new Date()) return response.status(404).json({ detail: 'Recording not found or expired' });
      const bytes = await audioStorage.read(row.storage_key);
      response.type(row.content_type || 'application/octet-stream');
      response.set('Content-Length', String(bytes.length));
      response.set('Cache-Control', 'private, no-store');
      return response.send(bytes);
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/recordings', authenticate, async (request, response, next) => {
    try {
      const filter = await scopedStoreFilter(request.user);
      if (request.query.store_id) {
        const store = await accessibleStore(String(request.query.store_id), { user: request.user });
        if (!store) return response.status(404).json({ detail: 'Store not found' });
        filter.store_id = store.id;
      }
      const fromDate = request.query.from_date ? new Date(`${request.query.from_date}T00:00:00Z`) : null;
      const toDate = request.query.to_date ? new Date(`${request.query.to_date}T00:00:00Z`) : null;
      if (fromDate || toDate) filter.captured_at = {};
      if (fromDate) filter.captured_at.$gte = fromDate;
      if (toDate) { toDate.setUTCDate(toDate.getUTCDate() + 1); filter.captured_at.$lt = toDate; }
      if (request.query.conversation_status) {
        const conversations = await ConversationModel.find({ ...await scopedStoreFilter(request.user), status: request.query.conversation_status }).select({ id: 1 }).lean();
        filter.conversation_id = { $in: conversations.map((item) => item.id) };
      }
      const page = Math.max(1, Number.parseInt(request.query.page || '1', 10) || 1);
      const pageSize = Math.min(100, Math.max(1, Number.parseInt(request.query.page_size || '25', 10) || 25));
      const [rows, total] = await Promise.all([
        AudioRecordingModel.find(filter).sort({ captured_at: -1, is_aggregate: -1, sequence: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
        AudioRecordingModel.countDocuments(filter),
      ]);
      const conversationIds = [...new Set(rows.map((row) => row.conversation_id).filter(Boolean))];
      const [conversations, stores, segments] = await Promise.all([
        ConversationModel.find({ id: { $in: conversationIds } }).lean(),
        StoreModel.find({ id: { $in: [...new Set(rows.map((row) => row.store_id))] } }).lean(),
        TranscriptSegmentModel.find({ conversation_id: { $in: conversationIds } }).sort({ start_time: 1 }).lean(),
      ]);
      const conversationsById = new Map(conversations.map((row) => [row.id, row]));
      const storesById = new Map(stores.map((row) => [row.id, row]));
      const snippets = new Map();
      for (const segment of segments) if (!snippets.has(segment.conversation_id)) snippets.set(segment.conversation_id, segment.translated_text || (segment.language === 'en' ? segment.original_text : 'English translation unavailable'));
      return response.json({
        recordings: rows.map((row) => ({
          id: row.id,
          captured_at: row.captured_at?.toISOString?.() || null,
          duration_seconds: row.duration_seconds || 0,
          byte_size: row.byte_size || 0,
          sequence: row.sequence || 0,
          is_aggregate: Boolean(row.is_aggregate),
          speaker_role: row.speaker_role || 'unknown',
          store_id: row.store_id,
          store_name: storesById.get(row.store_id)?.name || row.store_id,
          conversation_id: row.conversation_id || null,
          conversation_status: conversationsById.get(row.conversation_id)?.status || 'UNKNOWN',
          transcript_snippet: snippets.get(row.conversation_id) || '',
          analysis_status: 'pending',
          audio_available: new Date(row.retain_until) > new Date(),
          playback_path: `/api/v1/audio/recordings/${row.id}`,
          conversation_path: row.conversation_id ? `/conversations/${row.conversation_id}` : null,
        })),
        page,
        page_size: pageSize,
        total,
        pages: Math.ceil(total / pageSize),
      });
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/reports/history', authenticate, async (request, response, next) => {
    try {
      if (config.demoMode) return response.json({ reports: [] });
      const storeId = request.query.store_id ? String(request.query.store_id) : null;
      if (storeId && !await accessibleStore(storeId, { user: request.user })) {
        return response.status(404).json({ detail: 'Store not found' });
      }
      const limit = Math.min(200, Math.max(1, Number.parseInt(request.query.limit || '60', 10) || 60));
      const ids = storeId ? null : await visibleStoreIds(request.user);
      const filter = storeId ? { store_id: storeId } : ids === null ? {} : { store_id: { $in: ids } };
      const rows = await DailyReportModel.find(filter).sort({ generated_at: -1 }).limit(limit).lean();
      const visibleStores = await StoreModel.find(request.user.role === 'SUPER_ADMIN' ? {} : { organization_id: request.user.organization_id }).lean();
      const storeNames = new Map(visibleStores.map((store) => [store.id, store.name]));
      const reports = [];
      for (const row of rows) {
        let payload;
        try { payload = JSON.parse(row.payload_json || '{}'); } catch { continue; }
        if (!isLiveDailyReport(payload)) continue;
        reports.push({
          id: row.id,
          store_id: row.store_id,
          store_name: storeNames.get(row.store_id) || 'All stores',
          business_date: payload.business_date,
          generated_at: row.generated_at?.toISOString?.() || payload.generatedAt || null,
          report_status: payload.reportStatus || 'generated',
          summary: payload.daily_analysis.provider_summary.summary || '',
        });
      }
      return response.json({ reports });
    } catch (error) { return next(error); }
  });

  app.get('/api/v1/reports/:period', authenticate, async (request, response, next) => {
    try {
      if (!['daily', 'weekly', 'monthly'].includes(request.params.period)) {
        return response.status(404).json({ detail: 'Report period must be daily, weekly, or monthly' });
      }
      const storeId = request.query.store_id ? String(request.query.store_id) : '';
      if (request.params.period === 'daily' && config.demoMode) {
        return response.status(503).json({ detail: 'Daily reports are disabled in demo mode. Set DEMO_MODE=false to use live records.' });
      }
      const store = storeId ? await accessibleStore(storeId, { user: request.user }) : null;
      if (storeId && !store) return response.status(404).json({ detail: 'Store not found' });
      const businessDate = parseBusinessDate(request.query.business_date, store?.timezone);
      if (request.params.period === 'daily' && store) {
        const reportId = `daily-${store.id}-${businessDate}`;
        const saved = await DailyReportModel.findOne({ id: reportId }).lean();
        if (saved) {
          try {
            const payload = JSON.parse(saved.payload_json);
            if (!isLiveDailyReport(payload)) return response.status(404).json({ detail: 'Daily report not found' });
            return response.json(payload);
          } catch { return response.status(500).json({ detail: 'Saved daily report data is invalid. Generate the report again.' }); }
        }
      }
      const storeIds = store ? null : await visibleStoreIds(request.user);
      const stores = store
        ? [store]
        : await StoreModel.find(storeIds === null ? {} : { id: { $in: storeIds } }).lean();
      const contexts = await Promise.all(stores.map((item) => dailyReportContext(item, businessDate, request.params.period)));
      const report = combineReportContexts(contexts, request.params.period);
      return response.json({
        reportType: request.params.period,
        ...(request.params.period === 'daily' ? { reportStatus: 'not_generated' } : {}),
        generatedAt: new Date().toISOString(),
        pos_provider: config.posProvider,
        ...(store ? { store_name: store.name } : {}),
        ...report,
      });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/reports/daily/generate', authenticate, async (request, response, next) => {
    try {
      if (!['SUPER_ADMIN', 'ORG_ADMIN', 'STORE_MANAGER', 'SUPERVISOR'].includes(request.user.role)) {
        return response.status(403).json({ detail: 'Daily report generation requires a manager role' });
      }
      if (config.demoMode) {
        return response.status(503).json({ detail: 'Daily reports are disabled in demo mode. Set DEMO_MODE=false to use live records.' });
      }
      const storeId = requiredText(request.body, 'store_id', 64);
      const store = await accessibleStore(storeId, { user: request.user });
      if (!store) return response.status(404).json({ detail: 'Store not found' });
      const businessDate = parseBusinessDate(request.body.business_date, store.timezone);
      const reportId = `daily-${store.id}-${businessDate}`;
      const context = await dailyReportContext(store, businessDate);
      const { report, conversations, segments, transactions, recordings, runs, realOpportunities } = context;
      if (!report.metrics.conversations && !report.metrics.sales_data_available) {
        return response.status(409).json({ detail: 'No live conversations or real POS transactions are available for this business date.' });
      }
      const transcriptByConversation = new Map();
      for (const segment of segments) {
        const english = englishTranscriptText(segment);
        if (!english) continue;
        const list = transcriptByConversation.get(segment.conversation_id) || [];
        list.push(english);
        transcriptByConversation.set(segment.conversation_id, list);
      }
      const evidence = conversations.map((conversation) => ({
        conversation_id: conversation.id,
        started_at: conversation.started_at,
        transcript: (transcriptByConversation.get(conversation.id) || []).join(' ').slice(0, 1200),
      })).filter((item) => item.transcript).slice(0, 30);
      if (!config.groqApiKey) return response.status(503).json({ detail: 'Daily AI reports are not configured. Set GROQ_API_KEY on the backend service.' });
      const summary = await groqDailySummary({
        apiKey: config.groqApiKey,
        model: config.groqModel,
        businessDate,
        store: {
          name: store.name,
          city: store.city || '',
          region: store.region || '',
          timezone: store.timezone || 'UTC',
        },
        metrics: report.metrics,
        evidence,
      });
      if (!summary?.headline || !summary?.executive_summary
        || !Array.isArray(summary.findings) || !summary.findings.length
        || !Array.isArray(summary.actions_for_tomorrow) || !summary.actions_for_tomorrow.length) {
        return response.status(503).json({ detail: 'Groq AI returned an incomplete daily report; no report was saved. Retry generation.' });
      }
      const generatedAt = new Date().toISOString();
      const stringList = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string').map((item) => item.slice(0, 500)).slice(0, 10) : [];
      const executiveSummary = String(summary.executive_summary || 'Insufficient evidence for an executive summary.').slice(0, 3000);
      const reportByConversation = new Map();
      for (const run of [...runs].sort((left, right) => new Date(right.created_at || 0) - new Date(left.created_at || 0))) {
        if (['', 'mock', 'demo'].includes(String(run.provider || '').toLowerCase())
          || !String(run.input_excerpt || '').startsWith('[conversation-report]')
          || reportByConversation.has(run.conversation_id)) continue;
        try {
          const output = JSON.parse(run.output_json || '{}');
          if (output.kind === 'conversation_report' && output.report && typeof output.report === 'object') {
            reportByConversation.set(run.conversation_id, output.report);
          }
        } catch { continue; }
      }
      const formatMoney = (amount, currency = 'USD') => {
        const symbols = { USD: '$', CAD: 'CA$', EUR: '€', GBP: '£' };
        const value = Number(amount);
        const formatted = Math.abs(value - Math.round(value)) < 0.01
          ? Math.round(value).toLocaleString('en-US')
          : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return `${symbols[currency] || `${currency} `}${formatted}`;
      };
      const revenueEntries = Object.entries(report.metrics.revenue_by_currency || {});
      const totalRevenue = revenueEntries.reduce((sum, [, amount]) => sum + Number(amount || 0), 0);
      const revenueValue = !report.metrics.sales_data_available
        ? 'N/A'
        : revenueEntries.length > 1
          ? 'Multiple currencies'
          : formatMoney(totalRevenue, revenueEntries[0]?.[0] || 'USD');
      const avgTicketValue = !report.metrics.sales_data_available
        ? 'N/A'
        : !report.metrics.sales_count
          ? 'N/A'
          : revenueEntries.length > 1
            ? 'Multiple currencies'
            : formatMoney(totalRevenue / report.metrics.sales_count, revenueEntries[0]?.[0] || 'USD');
      const interactions = conversations.map((conversation, index) => {
        const conversationSegments = segments.filter((segment) => segment.conversation_id === conversation.id);
        const transcript = (transcriptByConversation.get(conversation.id) || []).slice(0, 12).join(' ').slice(0, 280);
        const conversationReport = reportByConversation.get(conversation.id) || {};
        const statuses = new Set(realOpportunities
          .filter((opportunity) => opportunity.conversation_id === conversation.id)
          .map((opportunity) => String(opportunity.status || '').toUpperCase()));
        const sentiment = String(conversationReport.customer_sentiment || 'Not analyzed');
        const opportunityType = conversationReport.opportunity_type
          || (statuses.has('MISSED') ? 'missed' : statuses.has('CONVERTED') ? 'converted' : statuses.has('OPEN') || statuses.has('REVIEW_REQUIRED') ? 'potential' : undefined);
        const endSeconds = conversationSegments.reduce((max, segment) => Math.max(max, Number(segment.end_time) || 0), 0);
        const capturedDuration = recordings
          .filter((recording) => recording.conversation_id === conversation.id)
          .reduce((total, recording) => total + Number(recording.duration_seconds || 0), 0);
        const startedAt = conversation.started_at ? new Date(conversation.started_at) : null;
        let time = '';
        if (startedAt && !Number.isNaN(startedAt.getTime())) {
          try {
            time = new Intl.DateTimeFormat('en-US', {
              timeZone: report.timezone,
              hour: '2-digit',
              minute: '2-digit',
            }).format(startedAt);
          } catch { time = startedAt.toISOString(); }
        }
        return {
          number: index + 1,
          time,
          location: [store.city, store.region].filter(Boolean).join(', ') || store.name,
          duration_seconds: Math.round((endSeconds || capturedDuration) * 10) / 10,
          sentiment,
          confidence: Number.isFinite(Number(conversationReport.confidence)) ? Math.min(1, Math.max(0, Number(conversationReport.confidence))) : null,
          transcript_summary: String(conversationReport.summary || transcript || 'No clear speech was captured for this interaction.').slice(0, 500),
          coaching_tip: String(conversationReport.recommendation || 'No conversation coaching analysis is available.').slice(0, 1000),
          customer_needs: stringList(conversationReport.customer_needs),
          products_discussed: stringList(conversationReport.products_discussed),
          opportunity_type: opportunityType,
          conversation_id: conversation.id,
        };
      });
      const sentimentCounts = { positive: 0, neutral: 0, negative: 0, mixed: 0 };
      for (const interaction of interactions) {
        const key = String(interaction.sentiment).toLowerCase();
        if (Object.hasOwn(sentimentCounts, key)) sentimentCounts[key] += 1;
      }
      const sentimentSampleSize = Object.values(sentimentCounts).reduce((sum, count) => sum + count, 0);
      const sentiment = Object.fromEntries(Object.entries(sentimentCounts).map(([key, count]) => [
        key,
        sentimentSampleSize ? Math.round((count / sentimentSampleSize) * 100) : 0,
      ]));
      sentiment.sample_size = sentimentSampleSize;
      const keyPoints = stringList(summary.findings).length
        ? stringList(summary.findings)
        : [];
      const actions = stringList(summary.actions_for_tomorrow);
      const provider = 'groq';
      if (!keyPoints.length || !actions.length) {
        return response.status(503).json({ detail: 'Groq AI returned an incomplete daily report; no report was saved. Retry generation.' });
      }
      const kpis = {
        revenue: {
          label: 'REVENUE',
          value: revenueValue,
          detail: report.metrics.sales_data_available ? `${report.metrics.sales_count} POS transaction(s)` : 'Live POS data unavailable.',
        },
        conversations: { label: 'CONVERSATIONS', value: String(report.metrics.conversations), detail: 'Recorded interactions' },
        avg_ticket: {
          label: 'AVG TICKET',
          value: avgTicketValue,
          detail: report.metrics.sales_data_available ? 'Per POS transaction' : 'Live POS data unavailable.',
        },
        missed: { label: 'MISSED', value: String(report.metrics.potential_missed_opportunities), detail: 'Potential opportunities; value not estimated.' },
        low_stock: { label: 'LOW STOCK', value: String(report.metrics.low_stock), detail: 'Items at or below their reorder level.' },
        redacted: { label: 'REDACTED', value: 'N/A', detail: 'Not tracked in this report.' },
      };
      const storeListener = {
        brand: 'STORE LISTENER',
        report_date: businessDate,
        headline: String(summary.headline || `${report.metrics.conversations || 'No'} conversations · ${revenueValue} POS sales`).slice(0, 240),
        store_name: store.name,
        store_location: [store.city, store.region].filter(Boolean).join(', '),
        generated_at: generatedAt,
        kpis,
        executive_summary: executiveSummary,
        key_points: keyPoints,
        sentiment,
        actions_for_tomorrow: actions,
        interactions,
      };
      const payload = {
        ...report,
        reportType: 'daily',
        reportStatus: 'generated',
        generatedAt: generatedAt,
        business_date: businessDate,
        timezone: report.timezone,
        dataMode: 'live',
        pos_provider: config.posProvider,
        store_id: store.id,
        store_name: store.name,
        store_listener: storeListener,
        metrics: report.metrics,
        daily_analysis: {
          ...report.daily_analysis,
          provider_summary: {
            summary: executiveSummary,
            findings: stringList(summary.findings).length ? stringList(summary.findings) : keyPoints,
            confidence: Math.min(1, Math.max(0, Number(summary.confidence) || 0)),
            provider,
            status: 'completed',
          },
        },
      };
      const saved = await DailyReportModel.findOne({ id: reportId });
      if (saved) {
        saved.payload_json = JSON.stringify(payload);
        saved.generated_at = new Date(generatedAt);
        await saved.save();
      } else {
        await DailyReportModel.create({
          id: reportId,
          store_id: store.id,
          period: 'daily',
          payload_json: JSON.stringify(payload),
          generated_at: new Date(generatedAt),
        });
      }
      await writeAudit(request.user, 'report.daily.generate', 'daily_report', reportId, `store=${store.id};business_date=${businessDate}`);
      return response.json(payload);
    } catch (error) { return next(error); }
  });

  app.delete('/api/v1/recordings/:recordingId', authenticate, async (request, response, next) => {
    try {
      requireRecordingManager(request.user);
      const recording = await AudioRecordingModel.findOne({
        id: request.params.recordingId,
        ...await scopedStoreFilter(request.user),
      }).lean();
      if (!recording) return response.status(404).json({ detail: 'Recording not found' });
      const deleted = recording.conversation_id
        ? await deleteConversationAudio([recording.conversation_id], recordingCleanupModels(), audioStorage)
        : {
          ...emptyCounts(),
          recordings: await deleteOrphanRecordings([recording], recordingCleanupModels(), audioStorage),
        };
      await writeAudit(
        request.user,
        'recording.deleted',
        'audio_recording',
        recording.id,
        `conversations=${deleted.conversations};recordings=${deleted.recordings}`,
      );
      return response.json({ id: recording.id, deleted: true, counts: deleted });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/recordings/bulk-delete', authenticate, async (request, response, next) => {
    try {
      requireRecordingManager(request.user);
      const body = request.body || {};
      const models = recordingCleanupModels();
      if (body.wipe_all === true) {
        if (body.confirm !== 'DELETE ALL RECORDINGS') return response.status(400).json({ detail: 'Confirm wipe with confirm="DELETE ALL RECORDINGS"' });
        let storeId = body.store_id ? String(body.store_id) : null;
        if (request.user.role === 'STORE_MANAGER') {
          if (!request.user.store_id) return response.status(403).json({ detail: 'Store manager wipe requires an assigned store' });
          if (storeId && storeId !== request.user.store_id) return response.status(403).json({ detail: 'Store managers can only wipe their own store' });
          storeId = request.user.store_id;
        } else if (storeId && !await accessibleStore(storeId, { user: request.user })) {
          return response.status(404).json({ detail: 'Store not found' });
        }

        const storeScope = storeId ? { store_id: storeId } : await scopedStoreFilter(request.user);
        const conversations = await ConversationModel.find(storeScope).select({ id: 1 }).lean();
        const conversationIds = conversations.map((row) => row.id);
        const totals = emptyCounts();
        for (let index = 0; index < conversationIds.length; index += 200) {
          addCleanupCounts(totals, await deleteConversationAudio(conversationIds.slice(index, index + 200), models, audioStorage));
        }
        const orphanRecordings = await AudioRecordingModel.find({
          ...storeScope,
          conversation_id: { $in: [null, ''] },
        }).lean();
        totals.recordings += await deleteOrphanRecordings(orphanRecordings, models, audioStorage);
        await writeAudit(
          request.user,
          'recording.wipe_all',
          'audio_recording',
          storeId || 'all',
          `conversations=${totals.conversations};recordings=${totals.recordings}`,
        );
        return response.json({ wipe_all: true, store_id: storeId, deleted: totals });
      }

      if (body.confirm !== 'DELETE') return response.status(400).json({ detail: 'Confirm bulk delete with confirm="DELETE"' });
      if (!Array.isArray(body.recording_ids) || body.recording_ids.length === 0) {
        return response.status(400).json({ detail: 'Select at least one recording to delete' });
      }
      if (body.recording_ids.length > 500 || body.recording_ids.some((id) => typeof id !== 'string' || !id.trim())) {
        return response.status(422).json({ detail: 'recording_ids must contain at most 500 non-empty ids' });
      }
      const uniqueIds = [...new Set(body.recording_ids)];
      const scope = await scopedStoreFilter(request.user);
      const recordings = await AudioRecordingModel.find({ ...scope, id: { $in: uniqueIds } }).lean();
      const foundIds = new Set(recordings.map((row) => row.id));
      const conversationIds = [...new Set(recordings.map((row) => row.conversation_id).filter(Boolean))];
      const orphanRecordings = recordings.filter((row) => !row.conversation_id);
      const totals = emptyCounts();
      for (let index = 0; index < conversationIds.length; index += 200) {
        addCleanupCounts(totals, await deleteConversationAudio(conversationIds.slice(index, index + 200), models, audioStorage));
      }
      totals.recordings += await deleteOrphanRecordings(orphanRecordings, models, audioStorage);
      const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
      await writeAudit(
        request.user,
        'recording.bulk_deleted',
        'audio_recording',
        [...foundIds].slice(0, 8).join(',') || 'none',
        `matched=${foundIds.size};conversations=${totals.conversations}`,
      );
      return response.json({
        wipe_all: false,
        requested: uniqueIds.length,
        matched: foundIds.size,
        missing_ids: missingIds,
        deleted: totals,
      });
    } catch (error) { return next(error); }
  });

  app.use((request, response) => response.status(404).json({ detail: 'Not found', request_id: request.id }));
  app.use((error, request, response, _next) => {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status === 500) console.error(`Unhandled API error rid=${request.id}`, error);
    return response.status(status).json({ detail: status === 500 ? 'Internal error' : error.message, request_id: request.id });
  });

  return app;
}