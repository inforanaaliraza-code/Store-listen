const emptyCounts = () => ({
  conversations: 0,
  recordings: 0,
  transcript_segments: 0,
  participants: 0,
  ai_runs: 0,
  intents: 0,
  opportunities: 0,
  recommendations: 0,
  missed_opportunities: 0,
  pos_matches: 0,
  audio_sessions: 0,
});

async function removeAudioFiles(recordings, audioStorage) {
  for (const recording of recordings) {
    try {
      await audioStorage.delete(recording.storage_key);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function deleteMany(model, filter) {
  if (!model) return 0;
  const result = await model.deleteMany(filter);
  return Number(result.deletedCount || 0);
}

export async function deleteConversationAudio(conversationIds, models, audioStorage) {
  if (!conversationIds.length) return emptyCounts();
  const recordings = models.AudioRecordingModel
    ? await models.AudioRecordingModel.find({ conversation_id: { $in: conversationIds } }).lean()
    : [];
  await removeAudioFiles(recordings, audioStorage);

  const counts = emptyCounts();
  counts.recordings = recordings.length;
  counts.missed_opportunities = await deleteMany(models.MissedOpportunityModel, { conversation_id: { $in: conversationIds } });
  counts.opportunities = await deleteMany(models.OpportunityModel, { conversation_id: { $in: conversationIds } });
  counts.recommendations = await deleteMany(models.SalesRecommendationModel, { conversation_id: { $in: conversationIds } });
  counts.intents = await deleteMany(models.CustomerIntentModel, { conversation_id: { $in: conversationIds } });
  counts.ai_runs = await deleteMany(models.AiProcessingRunModel, { conversation_id: { $in: conversationIds } });
  counts.pos_matches = await deleteMany(models.PosMatchModel, { conversation_id: { $in: conversationIds } });
  counts.transcript_segments = await deleteMany(models.TranscriptSegmentModel, { conversation_id: { $in: conversationIds } });
  counts.participants = await deleteMany(models.ParticipantModel, { conversation_id: { $in: conversationIds } });
  counts.audio_sessions = await deleteMany(models.AudioSessionModel, { conversation_id: { $in: conversationIds } });
  if (models.AudioRecordingModel) {
    await models.AudioRecordingModel.deleteMany({ conversation_id: { $in: conversationIds } });
  }
  counts.conversations = await deleteMany(models.ConversationModel, { id: { $in: conversationIds } });
  return counts;
}

export async function deleteOrphanRecordings(recordings, models, audioStorage) {
  if (!recordings.length) return 0;
  await removeAudioFiles(recordings, audioStorage);
  const result = await models.AudioRecordingModel.deleteMany({ id: { $in: recordings.map((row) => row.id) } });
  return Number(result.deletedCount || 0);
}

export async function cleanupExpiredRecordings(models, audioStorage, now = new Date(), batchSize = 100) {
  const expired = await models.AudioRecordingModel.find({ retain_until: { $lte: now } })
    .sort({ retain_until: 1 })
    .limit(batchSize)
    .lean();
  return deleteOrphanRecordings(expired, models, audioStorage);
}

export async function cleanupExpiredTranscripts(TranscriptSegmentModel, now, retentionDays, batchSize = 500) {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const expired = await TranscriptSegmentModel.find({ created_at: { $lte: cutoff } })
    .sort({ created_at: 1 })
    .limit(batchSize)
    .select({ id: 1 })
    .lean();
  if (!expired.length) return 0;
  return deleteMany(TranscriptSegmentModel, { id: { $in: expired.map((row) => row.id) } });
}

export function addCleanupCounts(target, values) {
  for (const [key, value] of Object.entries(values)) target[key] = (target[key] || 0) + Number(value || 0);
  return target;
}

export { emptyCounts };
