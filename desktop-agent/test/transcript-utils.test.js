const test = require('node:test');
const assert = require('node:assert/strict');

const {
  duration,
  filename,
  formatParagraphPlain,
  groupEntriesIntoParagraphs,
  normalizeSessions,
  pdfHtml,
  transcriptText,
} = require('../src/transcript-utils');

test('normalizes persisted capture and line timestamps and caps archives', () => {
  const [session] = normalizeSessions([{
    id: 'conv-1',
    fileNumber: '7',
    startedAt: '2026-10-13T12:00:00.000Z',
    endedAt: '2026-10-13T12:01:06.000Z',
    entries: [{ number: '2', capturedAt: '2026-10-13T12:00:05.000Z', segment: { originalText: 'hello' } }],
  }]);

  assert.equal(session.fileNumber, 7);
  assert.ok(session.startedAt instanceof Date);
  assert.ok(session.endedAt instanceof Date);
  assert.ok(session.entries[0].capturedAt instanceof Date);
  assert.equal(duration(session), '01:06');
  assert.equal(normalizeSessions(Array.from({ length: 501 }, (_, index) => ({ id: String(index), startedAt: '2026-10-13' }))).length, 500);
});

test('groups speech into paragraphs after a conversational pause', () => {
  const paragraphs = groupEntriesIntoParagraphs([
    { number: 1, capturedAt: new Date('2026-10-13T12:00:00.000Z'), segment: { originalText: 'Hello', language: 'en' } },
    { number: 2, capturedAt: new Date('2026-10-13T12:00:08.000Z'), segment: { originalText: 'Gracias', translatedText: 'Thank you', language: 'es' } },
    { number: 3, capturedAt: new Date('2026-10-13T12:00:30.000Z'), segment: { originalText: 'Need a charger', language: 'en' } },
  ]);
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0].entries.length, 2);
  assert.equal(paragraphs[1].entries.length, 1);
  assert.match(formatParagraphPlain(paragraphs[0].entries), /Hello Gracias/);
  assert.match(formatParagraphPlain(paragraphs[0].entries), /EN: Thank you/);
  assert.doesNotMatch(formatParagraphPlain(paragraphs[0].entries), /EN: Hello Thank you/);
});

test('English speech does not get an EN translation line even if it contains gracias', () => {
  const { isSpanishUtterance, formatParagraphStaffEnglish } = require('../src/transcript-utils');
  const mixed = "Hello, I'm a newbie Hi everyone, welcome to my channel Gracias Hello";
  assert.equal(isSpanishUtterance(mixed, 'en'), false);
  assert.equal(isSpanishUtterance('Necesito un cargador', 'es'), true);
  assert.equal(isSpanishUtterance('Gracias', 'es'), true);
  const englishOnly = formatParagraphStaffEnglish([
    { segment: { originalText: mixed, translatedText: mixed, language: 'en' } },
  ]);
  assert.equal(englishOnly, '');
});

test('TXT export uses paragraph flow with staff English line', () => {
  const session = {
    fileNumber: 4,
    startedAt: new Date('2026-10-13T12:00:00.000Z'),
    endedAt: new Date('2026-10-13T12:00:10.000Z'),
    status: 'ENDED',
    entries: [
      { number: 2, capturedAt: new Date('2026-10-13T12:00:05.000Z'), segment: { originalText: 'Need a charger', translatedText: 'Need a charger', language: 'en', speakerLabel: 'Unattributed speaker' } },
      { number: 1, capturedAt: new Date('2026-10-13T12:00:02.000Z'), segment: { originalText: 'Hello', translatedText: 'Hello', language: 'en' } },
    ],
  };
  const text = transcriptText('Store 001', 'Front PC', session);

  assert.match(text, /Store: Store 001/);
  assert.match(text, /Paragraph 1/);
  assert.match(text, /Hello Need a charger/);
  assert.match(text, /Duration: 00:10/);
  assert.doesNotMatch(text, /1\. /);
});

test('capture filenames are sanitized, unique by number and use the requested extension', () => {
  const session = { fileNumber: 12, startedAt: new Date('2026-10-13T12:03:04.000Z') };
  assert.equal(filename('../../North Star / Store', session, 'txt'), 'North-Star-Store-capture-012-2026-10-13T12-03-04-000Z.txt');
  assert.equal(filename('!!!', session, 'pdf').split('-capture-')[0], 'store');
});

test('PDF HTML escapes transcript and metadata while retaining translation gloss', () => {
  const html = pdfHtml({
    filename: '<img src=x onerror=alert(1)>',
    storeName: 'Store <001>',
    deviceName: 'Front & Register',
    status: 'ENDED',
    entries: [{
      number: 1,
      capturedAt: '2026-10-13T12:00:00.000Z',
      speaker: '<script>alert(1)</script>',
      time: '12:00 PM',
      language: 'es',
      originalText: '<img src=x onerror=alert(1)>',
      translatedText: 'Safe & translated',
      segment: {
        language: 'es',
        originalText: '<img src=x onerror=alert(1)>',
        translatedText: 'Safe & translated',
      },
    }],
  });

  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /Store &lt;001&gt;/);
  assert.match(html, /Safe &amp; translated/);
  assert.match(html, /<strong>EN<\/strong>/);
  assert.match(html, /Content-Security-Policy/);
  const longHtml = pdfHtml({
    entries: Array.from({ length: 1001 }, (_, index) => ({
      number: index + 1,
      capturedAt: new Date(Date.UTC(2026, 9, 13, 12, 0, index)).toISOString(),
      originalText: 'line',
      segment: { originalText: 'line', language: 'en' },
    })),
  });
  assert.ok((longHtml.match(/class="entry"/g) || []).length >= 1);
});

test('empty capture exports an explicit no-speech message', () => {
  const session = { fileNumber: 1, startedAt: new Date('2026-10-13T12:00:00.000Z'), endedAt: null, status: 'ENDED', entries: [] };
  assert.match(transcriptText('Store 1', 'PC', session), /No speech was recognized/);
  assert.match(pdfHtml({ entries: [] }), /No speech was recognized/);
});

test('normalizes legacy speaker attribution wording in saved transcripts', () => {
  const [session] = normalizeSessions([{
    id: 'conv-legacy',
    startedAt: '2026-10-13T12:00:00.000Z',
    entries: [{
      number: 1,
      capturedAt: '2026-10-13T12:00:01.000Z',
      segment: { speakerLabel: 'Speaker not identified', originalText: 'Hello', language: 'en' },
    }],
  }]);
  const text = transcriptText('Store 001', 'Front PC', session);

  assert.equal(session.entries[0].segment.speakerLabel, 'Speaker');
  assert.match(text, /Hello/);
  assert.doesNotMatch(text, /Speaker not identified/);
  assert.doesNotMatch(text, /Unattributed speaker/);
});
