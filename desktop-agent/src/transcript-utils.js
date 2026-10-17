(function exposeTranscriptTools(root, createTools) {
  const tools = createTools();
  if (typeof module === 'object' && module.exports) module.exports = tools;
  if (root) root.StoreListenTranscript = tools;
})(typeof window === 'undefined' ? null : window, () => {
  const PARAGRAPH_GAP_MS = 12_000;

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
          speakerLabel: !entry.segment.speakerLabel
            || entry.segment.speakerLabel === 'Speaker not identified'
            || entry.segment.speakerLabel === 'Unattributed speaker'
            ? 'Speaker'
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

  function entryTimestamp(entry) {
    if (entry?.capturedAt) return new Date(entry.capturedAt).getTime();
    if (Number.isFinite(entry?.timeline)) return Number(entry.timeline);
    return 0;
  }

  function groupEntriesIntoParagraphs(entries, gapMs = PARAGRAPH_GAP_MS) {
    const sorted = (Array.isArray(entries) ? entries : []).slice().sort((left, right) => {
      const delta = entryTimestamp(left) - entryTimestamp(right);
      if (delta !== 0) return delta;
      return (Number(left.number) || 0) - (Number(right.number) || 0);
    });
    const paragraphs = [];
    let current = null;
    for (const entry of sorted) {
      const at = entryTimestamp(entry);
      if (!current || at - current.endedAt > gapMs) {
        current = { startedAt: at, endedAt: at, entries: [entry] };
        paragraphs.push(current);
      } else {
        current.entries.push(entry);
        current.endedAt = at;
      }
    }
    return paragraphs;
  }

  function segmentFromEntry(entry) {
    if (entry?.segment && typeof entry.segment === 'object') return entry.segment;
    return entry || {};
  }

  const SHORT_SPANISH = new Set([
    'hola', 'gracias', 'adios', 'adiós', 'si', 'sí', 'bueno', 'buenas', 'buenos',
    'perdon', 'perdón', 'ayuda', 'claro', 'por favor',
  ]);
  const SPANISH_WORDS = new Set([
    'hola', 'gracias', 'senor', 'señor', 'tenemos', 'producto', 'necesito', 'quiero',
    'cuanto', 'cuánto', 'favor', 'dolares', 'dólares', 'buenos', 'buenas', 'adios',
    'adiós', 'cargador', 'precio', 'donde', 'dónde', 'telefono', 'teléfono', 'ayuda',
    'puedo', 'esta', 'está', 'tiene', 'tienen', 'por',
  ]);
  const ENGLISH_WORDS = new Set([
    'hello', 'hi', 'hey', 'i', 'im', 'i\'m', 'we', 'you', 'the', 'this', 'that',
    'need', 'want', 'have', 'please', 'yes', 'no', 'charger', 'phone', 'price',
    'welcome', 'channel', 'everyone', 'newbie', 'my', 'to', 'a', 'is', 'are',
  ]);

  function looksLikeSpanishText(text) {
    return isSpanishUtterance(text);
  }

  function isSpanishUtterance(text, language) {
    const value = String(text || '').trim();
    if (!value) return false;
    const lowered = value.toLowerCase();
    const phrase = lowered.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!phrase) return false;
    if (SHORT_SPANISH.has(phrase) || SHORT_SPANISH.has(lowered)) return true;
    const words = phrase.split(' ').filter(Boolean);
    const spanishCount = words.filter((word) => SPANISH_WORDS.has(word)).length;
    const englishCount = words.filter((word) => ENGLISH_WORDS.has(word)).length;
    if (spanishCount >= 2 && spanishCount > englishCount) return true;
    if ((language || '').toLowerCase() === 'es' && englishCount === 0) return true;
    if ((language || '').toLowerCase() === 'es' && spanishCount >= 1 && spanishCount >= englishCount) return true;
    if (/[¿¡ñáéíóúü]/i.test(value) && spanishCount >= 1 && englishCount === 0) return true;
    return false;
  }

  function paragraphParts(entries) {
    return (entries || []).map((entry) => {
      const segment = segmentFromEntry(entry);
      const original = String(segment.originalText || entry.original || '').trim();
      if (!original) return null;
      const translated = String(segment.translatedText || entry.translated || '').trim();
      const language = String(segment.language || entry.language || 'en').toLowerCase();
      const spanish = isSpanishUtterance(original, language);
      if (spanish) {
        const translation = translated && translated !== original && !isSpanishUtterance(translated)
          ? translated
          : '';
        return { kind: 'es', original, translation };
      }
      return { kind: 'text', original };
    }).filter(Boolean);
  }

  function formatParagraphSpoken(entries) {
    return paragraphParts(entries).map((part) => part.original).join(' ');
  }

  function formatParagraphStaffEnglish(entries) {
    const parts = paragraphParts(entries);
    return parts
      .filter((part) => part.kind === 'es')
      .map((part) => part.translation)
      .filter(Boolean)
      .join(' ');
  }

  function formatParagraphEnglish(entries) {
    const parts = paragraphParts(entries);
    return parts.map((part) => (
      part.kind === 'es' ? (part.translation || part.original) : part.original
    )).join(' ');
  }

  function formatParagraphPlain(entries) {
    const spoken = formatParagraphSpoken(entries);
    const staff = formatParagraphStaffEnglish(entries);
    if (staff && staff !== spoken) return `${spoken}\nEN: ${staff}`;
    return spoken;
  }

  function formatTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(date);
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
    const paragraphs = groupEntriesIntoParagraphs(session.entries || []);
    paragraphs.forEach((paragraph, index) => {
      lines.push(`--- Paragraph ${index + 1} · ${formatTime(paragraph.startedAt)} ---`);
      lines.push(formatParagraphPlain(paragraph.entries) || 'No speech recognized.');
      lines.push('');
    });
    if (!paragraphs.length) lines.push('No speech was recognized in this capture.');
    return lines.join('\n');
  }

  function pdfHtml(payload = {}) {
    const sourceEntries = Array.isArray(payload.entries) ? payload.entries.slice(0, 10000) : [];
    const canGroup = sourceEntries.some((entry) => entry.capturedAt || Number.isFinite(entry.timeline));
    const paragraphs = canGroup
      ? groupEntriesIntoParagraphs(sourceEntries)
      : sourceEntries.map((entry, index) => ({
        startedAt: entry.time || index,
        endedAt: entry.time || index,
        entries: [entry],
      }));
    const entryMarkup = paragraphs.map((paragraph, index) => {
      const mapped = paragraph.entries.map((entry) => (
        entry.segment ? entry : {
          segment: {
            originalText: entry.originalText || entry.original,
            translatedText: entry.translatedText || entry.translated,
            language: entry.language,
          },
          capturedAt: entry.capturedAt,
          number: entry.number,
        }
      ));
      const english = formatParagraphStaffEnglish(mapped);
      const spoken = formatParagraphSpoken(mapped);
      const stamp = typeof paragraph.startedAt === 'number'
        ? formatTime(paragraph.startedAt)
        : escapeHtml(String(paragraph.startedAt || ''));
      return `
    <article class="entry">
      <header><strong>Paragraph ${index + 1}</strong><span>${stamp}</span></header>
      <p>${escapeHtml(spoken || 'No speech recognized.')}</p>
      ${english && english !== spoken ? `<p class="en"><strong>EN</strong> ${escapeHtml(english)}</p>` : ''}
    </article>`;
    }).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
    *{box-sizing:border-box}body{margin:0;padding:34px;color:#1b2b22;font:12pt/1.55 Arial,sans-serif}h1{margin:0 0 6px;font-size:24pt}h2{margin:0 0 22px;color:#28744d;font-size:11pt;font-weight:600}.meta{margin-bottom:24px;padding:14px 16px;border:1px solid #dce8dd;background:#f5f9f4}.meta p{margin:3px 0}.entry{padding:16px 0;border-top:1px solid #dfe7df;break-inside:avoid}.entry header{display:flex;justify-content:space-between;gap:16px;color:#36714f;font-size:9pt}.entry header span{color:#748178}.entry p{margin:10px 0 0;font-size:13pt;line-height:1.65;overflow-wrap:anywhere}.entry .en{color:#3d5c4a;font-size:11pt}
    </style></head><body><h1>Store Listen</h1><h2>Capture ${escapeHtml(payload.filename || '')}</h2><section class="meta"><p><strong>Store:</strong> ${escapeHtml(payload.storeName)}</p><p><strong>Device:</strong> ${escapeHtml(payload.deviceName)}</p><p><strong>Started:</strong> ${escapeHtml(payload.startedAt)}</p><p><strong>Duration:</strong> ${escapeHtml(payload.duration)}</p><p><strong>Status:</strong> ${escapeHtml(payload.status)}</p></section>${entryMarkup || '<p>No speech was recognized in this capture.</p>'}</body></html>`;
  }

  return {
    PARAGRAPH_GAP_MS,
    normalizeSessions,
    duration,
    filename,
    groupEntriesIntoParagraphs,
    paragraphParts,
    looksLikeSpanishText,
    isSpanishUtterance,
    formatParagraphSpoken,
    formatParagraphStaffEnglish,
    formatParagraphEnglish,
    formatParagraphPlain,
    transcriptText,
    pdfHtml,
  };
});
