export type StoreListenEventName =
  | 'transcript.partial'
  | 'transcript.final'
  | 'speaker.detected'
  | 'language.detected'
  | 'translation.updated'
  | 'conversation.started'
  | 'conversation.ended'
  | 'intent.detected'
  | 'opportunity.detected'
  | 'sales_tip.generated'
  | 'missed_opportunity.detected'
  | 'pos.transaction.received'
  | 'pos.transaction.matched'
  | 'store.connected'
  | 'store.disconnected'
  | 'device.health.updated'
  | 'alert.created';

export interface TranscriptEvent {
  event: 'transcript.partial' | 'transcript.final';
  conversationId: string;
  segmentId: string;
  storeId: string;
  speakerId: string;
  language: 'en' | 'es' | string;
  originalText: string;
  translatedText: string;
  confidence: number;
  timestamp: string;
  isFinal: boolean;
}
