export async function translateToEnglish(text, {
  apiKey,
  apiUrl,
  fetchImpl = fetch,
  signal,
}) {
  const source = String(text || '').trim();
  if (!source) return '';
  if (!apiKey) throw new Error('DEEPL_API_KEY is required for Spanish-to-English translation.');

  const response = await fetchImpl(`${apiUrl}/v2/translate`, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ text: [source], target_lang: 'EN' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Translation service failed with HTTP ${response.status}.`);
  }
  const payload = await response.json();
  const translated = String(payload.translations?.[0]?.text || '').trim();
  if (!translated) throw new Error('Translation service returned an empty result.');
  return translated;
}