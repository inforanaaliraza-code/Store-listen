'use client';

import Link from '@/lib/router-link';
import { useParams } from '@/lib/router-hooks';
import { useEffect, useState } from 'react';
import { apiBlob, apiGet, apiPatch, apiPost, type Conversation } from '../../../../lib/api';

type Segment = { id: string; speaker_id: string; speaker_label?: string; speaker_role?: string; employee_id?: string | null; language: string; original_text: string; translated_text: string | null; confidence: number; start_time: number };
type Recording = { id: string; captured_at: string; duration_seconds: number; byte_size: number; sequence: number; speaker_role: string; playback_path: string };
type Opportunity = { id: string; customer_intent: string; product: string; status: string; confidence: number; recommendation: string; manager_note?: string | null };
type Recommendation = { id: string; title: string; message: string; confidence: number };
type ConversationReport = {
  summary: string;
  customer_needs: string[];
  customer_sentiment: 'positive' | 'neutral' | 'negative' | 'mixed' | 'unknown';
  products_discussed: string[];
  opportunity_type: 'missed' | 'potential' | 'none';
  opportunity_summary: string;
  recommendation: string;
  evidence: string;
  confidence: number;
};
type ConversationDetail = Conversation & {
  analysis_status: 'analyzed' | 'unavailable' | 'pending';
  analysis_run_count: number;
  opportunities: Opportunity[];
  recommendations: Recommendation[];
  conversation_report: ConversationReport | null;
};
type AnalysisResult = {
  analysis_status: 'analyzed' | 'unavailable' | 'pending';
  report: ConversationReport;
  transcript_generated: boolean;
  transcript_segments: number;
  provider: string;
};
type SpeakerRole = 'customer' | 'employee' | 'unknown';

function analysisStatusLabel(status: ConversationDetail['analysis_status']) {
  if (status === 'analyzed') return 'Analyzed';
  if (status === 'unavailable') return 'AI unavailable';
  return 'Pending AI';
}

function RecordingPlayer({ recording }: { recording: Recording }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  async function loadAudio() {
    setLoading(true);
    setError('');
    try {
      const blob = await apiBlob(recording.playback_path);
      setUrl(URL.createObjectURL(blob));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load audio');
    } finally {
      setLoading(false);
    }
  }

  if (url) return <audio className="analysis-audio" controls preload="none" src={url} aria-label={`Recording clip ${recording.sequence}`} />;
  return <div className="analysis-load-audio">
    <button className="ghost owner-button" onClick={() => void loadAudio()} disabled={loading}>{loading ? 'Loading…' : 'Load playback'}</button>
    {error ? <small className="error" role="alert">{error}</small> : null}
  </div>;
}

export default function ConversationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [segmentTotal, setSegmentTotal] = useState(0);
  const [loadingMoreSegments, setLoadingMoreSegments] = useState(false);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [recordingTotal, setRecordingTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [recordingError, setRecordingError] = useState('');
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisError, setAnalysisError] = useState('');
  const [analysisMessage, setAnalysisMessage] = useState('');
  const [speakerBusySegmentId, setSpeakerBusySegmentId] = useState('');
  const [speakerError, setSpeakerError] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    Promise.all([
      apiGet<ConversationDetail>(`/api/v1/conversations/${id}`),
      apiGet<{ segments: Segment[]; total: number }>(`/api/v1/conversations/${id}/transcript?page=1&page_size=100`),
      apiGet<{ recordings: Recording[]; total: number }>(`/api/v1/conversations/${id}/audio?page=1&page_size=20`),
    ]).then(([record, transcript, audio]) => {
      if (!active) return;
      setConversation(record);
      setSegments(transcript.segments);
      setSegmentTotal(transcript.total);
      setRecordings(audio.recordings);
      setRecordingTotal(audio.total);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Unable to load conversation');
    });
    return () => { active = false; };
  }, [id]);

  async function loadOlderSegments() {
    setLoadingMoreSegments(true);
    try {
      const page = Math.floor(segments.length / 100) + 1;
      const result = await apiGet<{ segments: Segment[]; total: number }>(`/api/v1/conversations/${id}/transcript?page=${page}&page_size=100`);
      setSegments((current) => [...current, ...result.segments]);
      setSegmentTotal(result.total);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load more transcript segments');
    } finally {
      setLoadingMoreSegments(false);
    }
  }

  async function loadOlderRecordings() {
    setLoadingMore(true);
    try {
      const page = Math.floor(recordings.length / 20) + 1;
      const result = await apiGet<{ recordings: Recording[]; total: number }>(`/api/v1/conversations/${id}/audio?page=${page}&page_size=20`);
      setRecordings((current) => [...current, ...result.recordings]);
      setRecordingTotal(result.total);
    } catch (cause) {
      setRecordingError(cause instanceof Error ? cause.message : 'Unable to load older recordings');
    } finally {
      setLoadingMore(false);
    }
  }

  async function assignSpeaker(segmentId: string, speakerRole: SpeakerRole) {
    setSpeakerBusySegmentId(segmentId);
    setSpeakerError('');
    try {
      const assignment = await apiPatch<{ speaker_id: string; speaker_label: string; speaker_role: SpeakerRole; employee_id: string | null }>(
        `/api/v1/conversations/${id}/transcript/${segmentId}/speaker`,
        { speaker_role: speakerRole },
      );
      setSegments((current) => current.map((segment) => segment.id === segmentId ? {
        ...segment,
        speaker_id: assignment.speaker_id,
        speaker_label: assignment.speaker_label,
        speaker_role: assignment.speaker_role,
        employee_id: assignment.employee_id,
      } : segment));
    } catch (cause) {
      setSpeakerError(cause instanceof Error ? cause.message : 'Unable to save the speaker label');
    } finally {
      setSpeakerBusySegmentId('');
    }
  }

  async function generateAnalysis() {
    setAnalysisBusy(true);
    setAnalysisError('');
    setAnalysisMessage('');
    try {
      const result = await apiPost<AnalysisResult>(`/api/v1/conversations/${id}/report`);
      setConversation((current) => current ? {
        ...current,
        analysis_status: result.analysis_status,
        analysis_run_count: current.analysis_run_count + 1,
        conversation_report: result.report,
      } : current);
      if (result.transcript_generated) {
        const transcript = await apiGet<{ segments: Segment[]; total: number }>(`/api/v1/conversations/${id}/transcript?page=1&page_size=100`);
        setSegments(transcript.segments);
        setSegmentTotal(transcript.total);
      }
      setAnalysisMessage(`Report ready · ${result.transcript_segments} transcript segments analyzed with ${result.provider}.`);
    } catch (cause) {
      setAnalysisError(cause instanceof Error ? cause.message : 'Unable to analyze this conversation');
    } finally {
      setAnalysisBusy(false);
    }
  }

  if (error) return <section className="error"><h1>Conversation unavailable</h1><p>{error}</p><Link href="/conversations">Back</Link></section>;
  if (!conversation) return <div className="skeleton" />;
  const missedOpportunity = conversation.opportunities.find((opportunity) => opportunity.status === 'MISSED');
  const report = conversation.conversation_report;
  const startedAt = new Date(conversation.started_at);

  return (
    <div className="analysis-page">
      <Link href="/conversations" className="analysis-back">← Back to conversations</Link>
      <header className="analysis-page-header">
        <div>
          <span className="eyebrow">CONVERSATION ANALYSIS · {conversation.language.toUpperCase()}</span>
          <h1 className="serif">Customer {conversation.id.slice(-6)}</h1>
          <div className="analysis-metadata">
            <span>Representative: {conversation.salesperson || 'Unassigned'}</span>
            <span>Date: {startedAt.toLocaleDateString()}</span>
            <span>Time: {startedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <span>{conversation.store_name ?? conversation.store_id}</span>
          </div>
        </div>
        <div className="analysis-header-status">
          <span className={`recording-analysis ${conversation.analysis_status}`}><i />{analysisStatusLabel(conversation.analysis_status)}</span>
          <span className={`recording-state ${conversation.status.toLowerCase()}`}>{conversation.status}</span>
        </div>
      </header>

      <section className="analysis-layout">
        <div className="analysis-side-column">
          <article className="panel analysis-player-panel">
            <div className="analysis-panel-heading"><span className="eyebrow">RECORDING</span><strong>{recordingTotal} recording{recordingTotal === 1 ? '' : 's'}</strong></div>
            {recordingError ? <p className="recording-error" role="alert">{recordingError}</p> : null}
            {recordings.length ? <>
              {recordings.slice(0, 1).map((recording) => <div className="analysis-featured-clip" key={recording.id}>
                <span className="analysis-clip-time">{new Date(recording.captured_at).toLocaleString()}</span>
                <span className="analysis-clip-duration">{recording.duration_seconds.toFixed(0)} sec · {recording.speaker_role === 'unknown' ? 'Speaker not attributed' : recording.speaker_role}</span>
                <RecordingPlayer recording={recording} />
              </div>)}
              {recordings.length > 1 ? <div className="analysis-more-clips">{recordings.slice(1).map((recording) => <div className="analysis-clip-row" key={recording.id}>
                <div><strong>Clip {recording.sequence + 1}</strong><small>{new Date(recording.captured_at).toLocaleTimeString()} · {recording.duration_seconds.toFixed(0)} sec</small></div>
                <RecordingPlayer recording={recording} />
              </div>)}</div> : null}
              {recordings.length < recordingTotal ? <button className="ghost owner-button" onClick={() => void loadOlderRecordings()} disabled={loadingMore}>{loadingMore ? 'Loading…' : `Load older clips (${recordings.length} of ${recordingTotal})`}</button> : null}
            </> : <div className="analysis-empty">No retained audio is available for this conversation.</div>}
          </article>

          <article className="panel analysis-insight-panel">
            <div className="analysis-panel-heading"><span className="eyebrow">AI ANALYSIS</span><span className={`recording-analysis ${conversation.analysis_status}`}><i />{analysisStatusLabel(conversation.analysis_status)}</span></div>
            {report ? <div className="analysis-report">
              <section className="analysis-report-summary"><span>SUMMARY</span><p>{report.summary}</p></section>
              <div className="analysis-report-grid">
                <section><span>CUSTOMER NEEDS</span>{report.customer_needs.length ? <ul>{report.customer_needs.map((need) => <li key={need}>{need}</li>)}</ul> : <p>Not clear from transcript</p>}</section>
                <section><span>CUSTOMER SENTIMENT</span><strong className={`analysis-sentiment ${report.customer_sentiment}`}>{report.customer_sentiment}</strong></section>
                <section><span>PRODUCTS DISCUSSED</span><p>{report.products_discussed.length ? report.products_discussed.join(', ') : 'None identified'}</p></section>
                <section><span>OPPORTUNITY</span><strong className={`analysis-opportunity ${report.opportunity_type}`}>{report.opportunity_type === 'none' ? 'No clear opportunity' : `${report.opportunity_type} opportunity`}</strong><p>{report.opportunity_summary || 'No supporting opportunity identified.'}</p></section>
              </div>
              {report.evidence ? <p className="analysis-report-evidence"><strong>Evidence</strong> {report.evidence}</p> : null}
              {report.recommendation ? <div className="analysis-recommendation"><strong>Recommended follow-up</strong><p>{report.recommendation}</p><small>{Math.round(report.confidence * 100)}% confidence · AI-generated estimate</small></div> : null}
            </div> : conversation.opportunities.length ? <div className="analysis-findings">
              {conversation.opportunities.map((opportunity) => <section className={`analysis-finding ${opportunity.status === 'MISSED' ? 'missed' : ''}`} key={opportunity.id}>
                <strong>{opportunity.status === 'MISSED' ? 'Missed opportunity marked for review' : 'Potential sales opportunity'}</strong>
                <p>{opportunity.customer_intent} · {opportunity.product}</p>
                <p>{opportunity.recommendation}</p>
                <div><span>{opportunity.status}</span><span>{Math.round(opportunity.confidence * 100)}% confidence</span></div>
                {opportunity.manager_note ? <small>Manager note: {opportunity.manager_note}</small> : null}
              </section>)}
            </div> : conversation.analysis_status === 'analyzed' ? <div className="analysis-empty">Analysis completed. No high-confidence sales opportunity was identified.</div> : conversation.analysis_status === 'unavailable' ? <div className="analysis-empty">The configured AI provider did not complete this analysis. Check its configuration, then retry.</div> : <div className="analysis-empty">No analysis has been generated for this conversation.</div>}
            {conversation.recommendations.length ? <div className="analysis-recommendations">
              {conversation.recommendations.map((recommendation) => <div className="analysis-recommendation" key={recommendation.id}>
                <strong>{recommendation.title}</strong>
                <p>{recommendation.message}</p>
                <small>{Math.round(recommendation.confidence * 100)}% confidence</small>
              </div>)}
            </div> : null}
            {analysisError ? <p className="error analysis-action-error" role="alert">{analysisError}</p> : null}
            {analysisMessage ? <p className="analysis-action-message" role="status">{analysisMessage}</p> : null}
            <button className="primary analysis-generate-button" onClick={() => void generateAnalysis()} disabled={analysisBusy || (!segments.length && !recordingTotal)}>
              {analysisBusy ? 'Transcribing and generating…' : report ? 'Regenerate AI Report' : conversation.analysis_status === 'unavailable' ? 'Retry AI Report' : 'Generate AI Report'}
            </button>
            {segments.length > 0 && segments.every((segment) => segment.speaker_id === 'speaker-unknown') ? <p className="analysis-caveat">Speaker attribution is unknown. The report summarizes transcript content without guessing who said each line.</p> : null}
            {!segments.length && recordingTotal > 0 ? <p className="analysis-caveat">No transcript is available yet. Generate the report to transcribe retained audio locally, then analyze it.</p> : null}
            <p className="analysis-caveat">Generating a report sends transcript text to Google Gemini. On Google’s free tier, content may be used to improve Google products; use only if your store policy permits.</p>
            <p className="analysis-caveat">AI findings are estimates for human review. Speaker labels are operator-selected, not voice identification.</p>
          </article>
        </div>

        <div className="analysis-transcript-column">
          {missedOpportunity || report?.opportunity_type === 'missed' ? <article className="analysis-missed-banner" role="status"><div><strong>Missed Opportunity Detected</strong><p>{report?.opportunity_summary || missedOpportunity?.recommendation || `${missedOpportunity?.customer_intent} · ${missedOpportunity?.product}`}</p></div></article> : null}
          <article className="panel analysis-transcript-panel">
            <div className="analysis-transcript-heading"><div><span className="eyebrow">CONVERSATION TEXT</span><h2>Transcript</h2></div><span>{segmentTotal} segments</span></div>
            {segments.length ? <div className="analysis-transcript-list">
              {speakerError ? <p className="error analysis-action-error" role="alert">{speakerError}</p> : null}
              {segments.map((segment) => {
                const speakerRole = segment.speaker_role || (segment.speaker_id === 'speaker-customer' ? 'customer' : segment.speaker_id.startsWith('speaker-employee-') ? 'employee' : 'unknown');
                const speaker = segment.speaker_label === 'Speaker not identified' || segment.speaker_label === 'Unattributed speaker'
                  ? 'Speaker'
                  : (segment.speaker_label || (speakerRole === 'customer' ? 'Customer' : speakerRole === 'employee' ? 'Representative' : 'Speaker'));
                const customer = speakerRole === 'customer';
                return <div className={`analysis-message ${customer ? 'customer' : 'representative'}`} key={segment.id}>
                  <div className="analysis-message-meta">
                    <span className="analysis-message-speaker"><i>{customer ? 'C' : speakerRole === 'employee' ? 'R' : '?'}</i>{speaker}</span>
                    <span>{segment.language.toUpperCase()} · {Math.round(segment.confidence * 100)}%</span>
                  </div>
                  <p>{segment.original_text}</p>
                  {segment.translated_text && segment.translated_text !== segment.original_text ? <small>EN · {segment.translated_text}</small> : null}
                  <div className="analysis-message-footer">
                    <time>{Math.floor(segment.start_time / 60).toString().padStart(2, '0')}:{Math.floor(segment.start_time % 60).toString().padStart(2, '0')}</time>
                    <label>Speaker
                      <select
                        value={speakerRole}
                        aria-label={`Assign speaker role for transcript at ${Math.floor(segment.start_time)} seconds`}
                        disabled={analysisBusy || conversation.analysis_status === 'analyzed' || speakerBusySegmentId === segment.id}
                        onChange={(event) => void assignSpeaker(segment.id, event.target.value as SpeakerRole)}
                      >
                        <option value="unknown">Needs review</option>
                        <option value="customer">Customer</option>
                        <option value="employee">Representative</option>
                      </select>
                    </label>
                  </div>
                </div>;
              })}
            {segments.length < segmentTotal ? <button className="ghost owner-button" onClick={() => void loadOlderSegments()} disabled={loadingMoreSegments}>{loadingMoreSegments ? 'Loading…' : `Load older transcript (${segments.length} of ${segmentTotal})`}</button> : null}
            </div> : <div className="analysis-empty analysis-transcript-empty">Transcript text will appear after speech has been processed.</div>}
          </article>
        </div>
      </section>
    </div>
  );
}
