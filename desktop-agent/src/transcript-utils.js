(function exposeTranscriptTools(root, createTools) {
  const tools = createTools();
  if (typeof module === 'object' && module.exports) module.exports = tools;
  if (root) root.StoreListenTranscript = tools;
})(typeof window === 'undefined' ? null : window, () => {
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function normalizeSessions(sessions) {
    if (!Array.isArray(sessions)) return [];
    return sessions.slice(0, 500).map((session, index) => ({
      ...session,
      id: String(session.id || `local-${index + 1}`),
      fileNumber: Number(session.fileNumber) || index + 1,
      startedAt: new Date(session.startedAt),
      endedAt: session.endedAt ? new Date(session.endedAt) : null,
      entries: Array.isArray(session.entries) ? session.entries.slice(0, 10000).map((entry, entryIndex) => ({
        ...entry,
        number: Number(entry.number) || entryIndex + 1,
        capturedAt: new Date(entry.capturedAt),
        segment: entry.segment && typeof entry.segment === 'object' ? {
          ...entry.segment,
          speakerLabel: entry.segment.speakerLabel === 'Speaker not identified'
            ? 'Unattributed speaker'
            : entry.segment.speakerLabel,
        } : entry.segment,
      })) : [],
    }));
  }

  function duration(session) {
    const end = session.endedAt || new Date();
    const seconds = Math.max(0, Math.floor((end - session.startedAt) / 1000));
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function filename(storeName, session, extension) {
    const store = String(storeName || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'store';
    const startedAt = new Date(session.startedAt);
    const date = startedAt.toISOString().replace(/[:.]/g, '-');
    return `${store}-capture-${String(session.fileNumber).padStart(3, '0')}-${date}.${extension}`;
  }

  function transcriptText(storeName, deviceName, session) {
    const lines = [
      'STORE LISTEN TRANSCRIPT',
      `Store: ${storeName}`,
      `Device: ${deviceName}`,
      `Capture: ${session.fileNumber}`,
      `Started: ${new Date(session.startedAt).toLocaleString()}`,
      `Duration: ${duration(session)}`,
      `Status: ${session.status}`,
      '',
    ];
    session.entries.slice().sort((left, right) => left.number - right.number).forEach((entry) => {
      const segment = entry.segment;
      lines.push(`${entry.number}. ${new Date(entry.capturedAt).toLocaleTimeString()} | ${segment.speakerLabel || 'Unattributed speaker'} | ${(segment.language || 'und').toUpperCase()}`);
      lines.push(segment.originalText || 'No speech recognized.');
      if (segment.translatedText && segment.translatedText !== segment.originalText) lines.push(`Translation: ${segment.translatedText}`);
      lines.push('');
    });
    if (!session.entries.length) lines.push('No speech was recognized in this capture.');
    return lines.join('\n');
  }

  function pdfHtml(payload = {}) {
    const entries = Array.isArray(payload.entries) ? payload.entries.slice(0, 10000) : [];
    const entryMarkup = entries.map((entry) => `
    <article class="entry">
      <header><strong>${escapeHtml(entry.number)}. ${escapeHtml(entry.speaker)}</strong><span>${escapeHtml(entry.time)} · ${escapeHtml(String(entry.language || 'und').toUpperCase())}</span></header>
      <p>${escapeHtml(entry.originalText)}</p>
      ${entry.translatedText && entry.translatedText !== entry.originalText ? `<p class="translation">${escapeHtml(entry.translatedText)}</p>` : ''}
    </article>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
    *{box-sizing:border-box}body{margin:0;padding:34px;color:#1b2b22;font:12pt/1.55 Arial,sans-serif}h1{margin:0 0 6px;font-size:24pt}h2{margin:0 0 22px;color:#28744d;font-size:11pt;font-weight:600}.meta{margin-bottom:24px;padding:14px 16px;border:1px solid #dce8dd;background:#f5f9f4}.meta p{margin:3px 0}.entry{padding:14px 0;border-top:1px solid #dfe7df;break-inside:avoid}.entry header{display:flex;justify-content:space-between;gap:16px;color:#36714f;font-size:9pt}.entry header span{color:#748178}.entry p{margin:8px 0 0;font-size:13pt;overflow-wrap:anywhere}.entry .translation{color:#65786b;font-size:11pt}
    </style></head><body><h1>Store Listen</h1><h2>Capture ${escapeHtml(payload.filename || '')}</h2><section class="meta"><p><strong>Store:</strong> ${escapeHtml(payload.storeName)}</p><p><strong>Device:</strong> ${escapeHtml(payload.deviceName)}</p><p><strong>Started:</strong> ${escapeHtml(payload.startedAt)}</p><p><strong>Duration:</strong> ${escapeHtml(payload.duration)}</p><p><strong>Status:</strong> ${escapeHtml(payload.status)}</p></section>${entryMarkup || '<p>No speech was recognized in this capture.</p>'}</body></html>`;
  }

  return { normalizeSessions, duration, filename, transcriptText, pdfHtml };
});