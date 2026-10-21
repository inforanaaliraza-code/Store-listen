import mongoose from 'mongoose';

function collectionModel(name, collection, fields = {}) {
  const schema = new mongoose.Schema({
    id: { type: String, required: true, index: true },
    ...fields,
  }, {
    collection,
    strict: false,
    timestamps: false,
    versionKey: false,
  });
  return mongoose.models[name] || mongoose.model(name, schema, collection);
}

export const User = collectionModel('StoreListenUser', 'users', {
  email: { type: String, index: true },
  full_name: String,
  password_hash: String,
  role: String,
  organization_id: { type: String, index: true },
  store_id: { type: String, index: true },
  is_active: Boolean,
});

export const Store = collectionModel('StoreListenStore', 'stores', {
  organization_id: { type: String, index: true },
  name: String,
  code: String,
  city: String,
  region: String,
  timezone: String,
  online: Boolean,
});

export const Employee = collectionModel('StoreListenEmployee', 'employees', {
  store_id: { type: String, index: true },
  full_name: String,
  role_title: String,
  active: Boolean,
});

export const EmployeePerformance = collectionModel('StoreListenEmployeePerformance', 'employee_performance', {
  employee_id: { type: String, index: true }, period: String,
  conversations_handled: Number, opportunities_detected: Number,
  opportunities_converted: Number, potential_missed: Number,
  avg_response_seconds: Number, conversion_rate: Number,
});

export const DevcoreTask = collectionModel('StoreListenDevcoreTask', 'devcore_tasks', {
  project_id: { type: String, index: true }, title: String, description: String,
  status: String, priority: String, assignee: String, due_date: String, labels: String, sort_order: Number,
});

export const IntegrationConnection = collectionModel('StoreListenIntegrationConnection', 'integration_connections', {
  kind: String, provider: String, status: String, notes: String,
});

export const AuditLog = collectionModel('StoreListenAuditLog', 'audit_logs', {
  actor_id: String,
  action: String,
  entity: String,
  entity_id: String,
  created_at: Date,
});

export const Conversation = collectionModel('StoreListenConversation', 'conversations', {
  store_id: { type: String, index: true },
  data_source: String,
  status: { type: String, index: true },
  primary_language: String,
  employee_id: { type: String, index: true },
  detected_product: String,
  customer_intent: String,
  opportunity_status: String,
  started_at: Date,
  ended_at: Date,
});

export const ConversationParticipant = collectionModel('StoreListenConversationParticipant', 'conversation_participants', {
  conversation_id: { type: String, index: true },
  speaker_label: String,
  mapped_role: String,
  employee_id: String,
});

export const TranscriptSegment = collectionModel('StoreListenTranscriptSegment', 'transcript_segments', {
  conversation_id: { type: String, index: true },
  speaker_id: String,
  language: String,
  original_text: String,
  translated_text: String,
  start_time: Number,
  end_time: Number,
  confidence: Number,
  is_final: Boolean,
  created_at: Date,
});

export const AudioSession = collectionModel('StoreListenAudioSession', 'audio_sessions', {
  store_id: { type: String, index: true },
  device_id: { type: String, index: true },
  conversation_id: { type: String, index: true },
  source_type: String,
  retain_until: Date,
  stored_audio: Boolean,
});

export const AudioRecording = collectionModel('StoreListenAudioRecording', 'audio_recordings', {
  conversation_id: { type: String, index: true },
  store_id: { type: String, index: true },
  content_type: String,
  byte_size: Number,
  duration_seconds: Number,
  sequence: Number,
  speaker_role: String,
  is_aggregate: Boolean,
  storage_key: String,
  captured_at: Date,
  retain_until: Date,
});

export const StoreDevice = collectionModel('StoreListenStoreDevice', 'store_devices', {
  store_id: { type: String, index: true },
  approval_status: String,
  status: String,
  name: String,
  audio_source: String,
  version: String,
  secret_hash: String,
  revoked: Boolean,
  last_heartbeat: Date,
  approved_at: Date,
  approved_by: String,
  cpu_pct: Number,
  memory_pct: Number,
  audio_status: String,
  microphone_status: String,
  stream_status: String,
  processing_latency_ms: Number,
});

export const StockItem = collectionModel('StoreListenStockItem', 'stock_items', {
  store_id: { type: String, index: true }, sku: String, name: String,
  cost: Number, price: Number, quantity: Number, par_level: Number, created_at: Date,
});

export const StoreRule = collectionModel('StoreListenStoreRule', 'store_rules', {
  store_id: { type: String, index: true }, name: String, dollar_value: Number,
  trigger_condition: String, expected_action: String, active: Boolean, created_at: Date,
});

export const ProductOpportunity = collectionModel('StoreListenProductOpportunity', 'product_opportunities', {
  conversation_id: { type: String, index: true }, store_id: { type: String, index: true },
  employee_id: String, customer_intent: String, product_name: String, status: { type: String, index: true },
  confidence: Number, recommendation: String, manager_note: String, reviewed_at: Date, created_at: Date,
});

export const SalesRecommendation = collectionModel('StoreListenSalesRecommendation', 'sales_recommendations', {
  conversation_id: { type: String, index: true }, store_id: { type: String, index: true },
  title: String, message: String, confidence: Number, created_at: Date,
});

export const Alert = collectionModel('StoreListenAlert', 'alerts', {
  store_id: { type: String, index: true }, severity: String, title: String,
  description: String, created_at: Date, acknowledged: Boolean,
});

export const AiProcessingRun = collectionModel('StoreListenAiProcessingRun', 'ai_processing_runs', {
  conversation_id: { type: String, index: true }, provider: String, status: String,
  input_excerpt: String, output_json: String, created_at: Date,
});

export const DailyReport = collectionModel('StoreListenDailyReport', 'daily_reports', {
  store_id: { type: String, index: true }, period: String, payload_json: String, generated_at: Date,
});

export const CustomerIntent = collectionModel('StoreListenCustomerIntent', 'customer_intents', {
  conversation_id: { type: String, index: true }, intent: String, product: String, confidence: Number, source: String,
});

export const MissedOpportunity = collectionModel('StoreListenMissedOpportunity', 'missed_opportunities', {
  conversation_id: { type: String, index: true }, opportunity_id: { type: String, index: true }, reason: String, confidence: Number,
});

export const PosTransaction = collectionModel('StoreListenPosTransaction', 'pos_transactions', {
  store_id: { type: String, index: true }, employee_id: String, amount: Number, currency: String,
  occurred_at: Date, provider: String,
});

export const PosTransactionItem = collectionModel('StoreListenPosTransactionItem', 'pos_transaction_items', {
  transaction_id: { type: String, index: true }, sku: String, name: String, unit_price: Number,
});

export const ConversationPosMatch = collectionModel('StoreListenConversationPosMatch', 'conversation_pos_matches', {
  conversation_id: { type: String, index: true }, transaction_id: String, confidence: Number,
});