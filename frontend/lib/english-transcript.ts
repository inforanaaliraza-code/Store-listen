export const ENGLISH_TRANSLATION_PENDING = 'English translation pending';

const SPANISH_MARKERS = new Set([
  'hola', 'gracias', 'senor', 'tenemos', 'producto', 'necesito', 'quiero', 'cuanto', 'favor',
  'dolares', 'buenos', 'buenas', 'adios', 'fui', 'dia', 'amiga', 'amigas', 'amigo', 'amigos',
  'dijeron', 'eran', 'clientes', 'puedes', 'cuesta', 'ahora', 'porque', 'comprar', 'donde',
  'puedo', 'tiene', 'tienen', 'cargador', 'precio', 'telefono', 'ayuda', 'estamos',
]);

export function containsSpanishClause(text: string) {
  if (/[¿¡ñáéíóúü]/i.test(text)) return true;
  const words = new Set(text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z]+/g) || []);
  return [...SPANISH_MARKERS].filter((word) => words.has(word)).length >= 2;
}

export function englishTranscriptText(original: string, englishText: string | null | undefined, language: string) {
  const source = original.trim();
  const needsTranslation = language.toLowerCase().split('-')[0] !== 'en' || containsSpanishClause(source);
  if (!needsTranslation) return source;

  const translation = englishText?.trim() || '';
  if (
    translation
    && translation !== source
    && translation !== ENGLISH_TRANSLATION_PENDING
    && !/translation unavailable/i.test(translation)
    && !containsSpanishClause(translation)
  ) return translation;

  return translation === ENGLISH_TRANSLATION_PENDING ? ENGLISH_TRANSLATION_PENDING : source;
}