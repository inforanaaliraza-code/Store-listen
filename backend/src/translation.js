import { translateWithGroq } from './groq-ai.js';

const DISTINCTIVE_SPANISH_WORDS = new Set([
  'adios', 'ayuda', 'buenas', 'buenos', 'cargador', 'como', 'cuanto', 'donde',
  'estas', 'estamos', 'favor', 'gracias', 'hola', 'necesito', 'precio', 'quiero',
  'senor', 'telefono', 'tenemos', 'tiene', 'tienen',
]);
const SHORT_SPANISH_PHRASES = new Set(['adios', 'ayuda', 'buenas', 'buenos', 'gracias', 'hola', 'perdon']);

export function isSpanishTranscript(text, language) {
  const value = String(text || '').trim();
  const languages = (Array.isArray(language) ? language : [language])
    .map((item) => String(item || '').toLowerCase().split('-')[0]);
  if (languages.some((item) => item === 'es')) return true;

  const words = value.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z]+/g) || [];
  if (SHORT_SPANISH_PHRASES.has(words.join(' '))) return true;
  const distinctiveCount = words.filter((word) => DISTINCTIVE_SPANISH_WORDS.has(word)).length;
  return distinctiveCount >= 2 || (/[¿¡ñáéíóúü]/i.test(value) && distinctiveCount >= 1);
}

export async function translateToEnglish(text, {
  apiKey,
  apiUrl,
  groqApiKey,
  groqModel,
  fetchImpl = fetch,
  signal,
}) {
  const source = String(text || '').trim();
  if (!source) return '';
  const translateWithFallback = async (deepLFailure) => {
    if (!groqApiKey) {
      throw deepLFailure || new Error('Set GROQ_API_KEY or DEEPL_API_KEY for Spanish-to-English translation.');
    }
    try {
      return await translateWithGroq({
        apiKey: groqApiKey,
        model: groqModel,
        text: source,
        fetchImpl,
      });
    } catch (groqFailure) {
      const cause = deepLFailure ? `${deepLFailure.message} Groq fallback: ${groqFailure.message}` : groqFailure.message;
      throw new Error(`Spanish-to-English translation failed. ${cause}`);
    }
  };

  if (!apiKey) return translateWithFallback();

  try {
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
      throw new Error(`DeepL failed with HTTP ${response.status}.`);
    }
    const payload = await response.json();
    const translated = String(payload.translations?.[0]?.text || '').trim();
    if (!translated) throw new Error('DeepL returned an empty result.');
    return translated;
  } catch (error) {
    if (!groqApiKey) throw error;
    return translateWithFallback(error);
  }
}