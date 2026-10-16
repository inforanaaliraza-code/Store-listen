const test = require('node:test');
const assert = require('node:assert/strict');

const { duration, filename, normalizeSessions, pdfHtml, transcriptText } = require('../src/transcript-utils');

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

test('TXT export keeps transcript lines in chronological order with translations', () => {
  const session = {
    fileNumber: 4,
    startedAt: new Date('2026-10-13T12:00:00.000Z'),
    endedAt: new Date('2026-10-13T12:00:10.000Z'),
    status: 'ENDED',
    entries: [
      { number: 2, capturedAt: new Date('2026-10-13T12:00:05.000Z'), segment: { originalText: 'Need a charger', translatedText: 'Necesito un cargador', language: 'en', speakerLabel: 'Unattributed speaker' } },
      { number: 1, capturedAt: new Date('2026-10-13T12:00:02.000Z'), segment: { originalText: 'Hello', translatedText: 'Hello', language: 'en' } },
    ],
  };
  const text = transcriptText('Store 001', 'Front PC', session);

  assert.match(text, /Store: Store 001/);
  assert.ok(text.indexOf('1. ') < text.indexOf('2. '));
  assert.match(text, /Translation: Necesito un cargador/);
  assert.match(text, /Duration: 00:10/);
});

test('capture filenames are sanitized, unique by number and use the requested extension', () => {
  const session = { fileNumber: 12, startedAt: new Date('2026-10-13T12:03:04.000Z') };
  assert.equal(filename('../../North Star / Store', session, 'txt'), 'North-Star-Store-capture-012-2026-10-13T12-03-04-000Z.txt');
  assert.equal(filename('!!!', session, 'pdf').split('-capture-')[0], 'store');
});

test('PDF HTML escapes transcript and metadata while retaining translation', () => {
  const html = pdfHtml({
    filename: '<img src=x onerror=alert(1)>',
    storeName: 'Store <001>',
    deviceName: 'Front & Register',
    status: 'ENDED',
    entries: [{
      number: 1,
      speaker: '<script>alert(1)</script>',
      time: '12:00 PM',
      language: 'en',
      originalText: '<img src=x onerror=alert(1)>',
      translatedText: 'Safe & translated',
    }],
  });

  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Store &lt;001&gt;/);
  assert.match(html, /Safe &amp; translated/);
  assert.match(html, /Content-Security-Policy/);
  const longHtml = pdfHtml({ entries: Array.from({ length: 1001 }, (_, index) => ({ number: index + 1, originalText: 'line' })) });
  assert.equal((longHtml.match(/class="entry"/g) || []).length, 1001);
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
  assert.match(text, /Speaker/);
  assert.doesNotMatch(text, /Speaker not identified/);
  assert.doesNotMatch(text, /Unattributed speaker/);
});