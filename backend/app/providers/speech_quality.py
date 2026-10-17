"""Transcript quality guards — reject Whisper hallucinations and non-EN/ES speech."""

from __future__ import annotations

import re
import time
import unicodedata
from collections import Counter

# Store capture only supports English and Spanish.
SUPPORTED_LANGUAGES = frozenset({"en", "es"})

# Classic Whisper empty-audio / YouTube / multilingual filler.
_HALLUCINATION_EXACT = frozenset(
    {
        "thank you",
        "thanks",
        "thanks for watching",
        "thank you for watching",
        "please subscribe",
        "subscribe",
        "bye",
        "goodbye",
        "you",
        "the end",
        "music",
        "applause",
        "silence",
        ".",
        "...",
        "mbc",
        "amara.org",
        "subtitles by",
        "translated by",
        "tchau",
        "chao",
        "obrigado",
        "obrigada",
        "adeus",
        "valeu",
        "e ai",
        "e aí",
        "ai",
        "aí",
        "ei",
        "oie",
        "opa",
        "okay",
        "ok",
        "hmm",
        "uh",
        "um",
        "ah",
        "yeah",
        "yep",
        "mhm",
        "mm",
        "mmm",
    }
)

_HALLUCINATION_CONTAINS = (
    "thanks for watching",
    "thank you for watching",
    "please subscribe",
    "subscribe to",
    "subtitles by",
    "amara.org",
    "translated by the",
    "♪",
    "🎵",
    "transcribe only",
    "clear spoken english",
    "spoken english or spanish",
    "do not invent phrases",
    "retail store conversation",
    "between a customer and an employee",
    "thanks for watching or subscribe",
    "terima kasih",
    "telah menonton",
    "menonton",
    "ありがとう",
)

# Portuguese / other-language tokens Whisper invents on noise (not EN/ES store speech).
_PORTUGUESE_OR_FOREIGN_TOKENS = frozenset(
    {
        "tchau",
        "obrigado",
        "obrigada",
        "adeus",
        "valeu",
        "voce",
        "você",
        "nao",
        "não",
        "pra",
        "porque",
        "então",
        "entao",
        "ciao",
        "grazie",
        "bonjour",
        "merci",
        "danke",
        "arigato",
        "namaste",
        "shukriya",
        "shukria",
        "ai",
        "aí",
        "oie",
        "opa",
        "ei",
        "terima",
        "kasih",
        "menonton",
    }
)

# Clear short Spanish store phrases that are allowed alone.
_ALLOWED_SHORT_ES = {
    "hola": "Hello",
    "gracias": "Thank you",
    "adios": "Goodbye",
    "adiós": "Goodbye",
    "si": "Yes",
    "sí": "Yes",
    "no": "No",
    "bueno": "Okay",
    "buenas": "Good day",
    "buenos": "Good day",
    "perdon": "Excuse me",
    "perdón": "Excuse me",
    "ayuda": "Help",
    "claro": "Of course",
}

_ALLOWED_SHORT_EN = frozenset(
    {
        "hello",
        "hi",
        "yes",
        "no",
        "please",
        "sorry",
        "help",
        "charger",
        "phone",
        "iphone",
        "cable",
        "price",
        "thanks",  # alone still often junk — handled via exact set above first
    }
)

_WORD_RE = re.compile(r"[a-záéíóúüñ']+", re.IGNORECASE)

# Recent identical lines per conversation (process-local anti-spam).
_RECENT_LINES: dict[str, tuple[str, float]] = {}
_RECENT_TTL_SEC = 18.0


def normalize_language(language: str | None) -> str | None:
    if not language:
        return None
    code = language.lower().replace("_", "-").split("-")[0]
    return code if code in SUPPORTED_LANGUAGES else None


def _strip_accents(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text or "")
    return "".join(char for char in decomposed if unicodedata.category(char) != "Mn")


def _normalize_phrase(text: str) -> str:
    cleaned = re.sub(r"[^\w\s]", " ", _strip_accents(text or "").lower(), flags=re.UNICODE)
    return " ".join(cleaned.split())


def looks_like_spanish(text: str) -> bool:
    lowered = (text or "").lower()
    if any(marker in lowered for marker in ("¿", "¡", "ñ", "á", "é", "í", "ó", "ú", "ü")):
        return True
    phrase = _normalize_phrase(text)
    if phrase in _ALLOWED_SHORT_ES:
        return True
    spanish_hits = (
        "hola",
        "gracias",
        "quiero",
        "necesito",
        "tiene",
        "tienen",
        "cuanto",
        "cuánto",
        "por favor",
        "buenos",
        "buenas",
        "cargador",
        "precio",
        "donde",
        "dónde",
        "telefono",
        "teléfono",
        "iphone",
        "ayuda",
        "puedo",
        "esta",
        "está",
        "ese",
        "esa",
        "como",
        "cómo",
        "adios",
        "adiós",
    )
    words = set(_WORD_RE.findall(lowered))
    return sum(1 for token in spanish_hits if token in words or token in lowered) >= 2


def looks_like_foreign_non_store(text: str) -> bool:
    words = {w.lower() for w in _WORD_RE.findall(text or "")}
    if not words:
        return False
    # Any Portuguese/foreign token without clear Spanish context → reject.
    foreign_hits = words & _PORTUGUESE_OR_FOREIGN_TOKENS
    if foreign_hits and not looks_like_spanish(text):
        return True
    if foreign_hits and len(words) <= 2:
        return True
    return False


def is_hallucinated_transcript(text: str) -> bool:
    """Return True when the model invented filler instead of real store speech."""
    phrase = _normalize_phrase(text)
    if not phrase:
        return True
    if phrase in _HALLUCINATION_EXACT:
        return True
    for marker in _HALLUCINATION_CONTAINS:
        if marker in phrase:
            return True
    if looks_like_foreign_non_store(text):
        return True

    words = _WORD_RE.findall(phrase)
    if not words:
        return True

    lowered_words = [_strip_accents(word.lower()) for word in words]
    allowed_short = set(_ALLOWED_SHORT_ES) | {token for token in _ALLOWED_SHORT_EN if token not in {"thanks", "thank"}}

    # Single unclear/filler token (unless allow-listed Spanish/English store word).
    if len(lowered_words) == 1:
        token = lowered_words[0]
        if token in _PORTUGUESE_OR_FOREIGN_TOKENS:
            return True
        if token in _HALLUCINATION_EXACT:
            return True
        if token in _ALLOWED_SHORT_ES:
            return False
        if token in _ALLOWED_SHORT_EN and token not in {"thanks", "thank"}:
            return False
        # Only drop tiny filler tokens. Real one-word store speech ("price", "phone") must show.
        if len(token) <= 2:
            return True

    # Ultra-short unclear clips like "E aí" / "ei ei" — not real store speech.
    if len(lowered_words) <= 2 and all(len(token) <= 3 for token in lowered_words):
        if not any(token in allowed_short for token in lowered_words) and not looks_like_spanish(text):
            return True

    counts = Counter(lowered_words)
    top_word, top_count = counts.most_common(1)[0]
    spam_tokens = {
        "thank",
        "thanks",
        "you",
        "bye",
        "okay",
        "ok",
        "uh",
        "um",
        "ah",
        "tchau",
        "obrigado",
        "obrigada",
    }
    if top_word in spam_tokens and top_count >= 2:
        return True
    if len(words) >= 4 and top_count / len(words) >= 0.55 and top_word in spam_tokens:
        return True
    if len(set(lowered_words)) == 1 and len(words) >= 2:
        return True
    if len(words) >= 6:
        unique_ratio = len(set(lowered_words)) / len(words)
        if unique_ratio <= 0.25:
            return True
    return False


def _segment_value(segment, name: str):
    value = segment.get(name) if isinstance(segment, dict) else getattr(segment, name, None)
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def filter_whisper_segments(segments) -> str | None:
    """Keep only text Whisper itself believes is speech.

    Whisper invents sentences on silence and room noise. verbose_json reports how likely each
    segment is to be silence (no_speech_prob), how confident the decoder was (avg_logprob) and
    whether it looped (compression_ratio). Returns None when the provider gave no segment data,
    "" when every segment was rejected, otherwise the joined kept text.
    """
    if not segments:
        return None
    kept: list[str] = []
    for segment in segments:
        text = segment.get("text") if isinstance(segment, dict) else getattr(segment, "text", "")
        text = str(text or "").strip()
        if not text:
            continue
        no_speech = _segment_value(segment, "no_speech_prob")
        logprob = _segment_value(segment, "avg_logprob")
        compression = _segment_value(segment, "compression_ratio")
        if no_speech is not None and no_speech > 0.85:
            continue
        if no_speech is not None and logprob is not None and no_speech > 0.6 and logprob < -1.0:
            continue
        if logprob is not None and logprob < -1.6:
            continue
        if compression is not None and compression > 2.4:
            continue
        kept.append(text)
    return " ".join(kept)


def sanitize_transcript(text: str) -> str:
    cleaned = " ".join((text or "").split()).strip(" \t\n\r.-")
    return cleaned


def is_usable_english_translation(original: str, translated: str) -> bool:
    """True when translated text is real English staff can read (not Spanish echo / junk)."""
    translated_clean = sanitize_transcript(translated)
    if not translated_clean or is_hallucinated_transcript(translated_clean):
        return False
    if _normalize_phrase(translated_clean) == _normalize_phrase(original):
        return False
    # Still Spanish → not usable for English-only staff.
    if looks_like_spanish(translated_clean) and not looks_like_spanish(original):
        return False
    if looks_like_spanish(translated_clean) and _normalize_phrase(translated_clean) == _normalize_phrase(original):
        return False
    if looks_like_spanish(translated_clean) and len(_WORD_RE.findall(translated_clean)) >= 3:
        # Long Spanish left untranslated is useless for staff.
        spanish_markers = ("señor", "senor", "tenemos", "producto", "gracias", "hola", "dólares", "dolares", "por")
        lowered = _normalize_phrase(translated_clean)
        if sum(1 for marker in spanish_markers if marker in lowered) >= 2:
            return False
    return True


def polish_spanish_translation(original: str, translated: str) -> str:
    """Keep staff EN line honest for short Spanish; drop unrelated invents."""
    phrase = _normalize_phrase(original)
    if phrase in _ALLOWED_SHORT_ES:
        return _ALLOWED_SHORT_ES[phrase]
    translated_clean = sanitize_transcript(translated)
    if not is_usable_english_translation(original, translated_clean):
        # Prefer empty sentinel so callers can retry; short phrases still get dictionary EN.
        return _ALLOWED_SHORT_ES.get(phrase, "")
    orig_words = _WORD_RE.findall(phrase)
    trans_words = _WORD_RE.findall(_normalize_phrase(translated_clean))
    # One Spanish word must not become a long invented English sentence.
    if len(orig_words) <= 2 and len(trans_words) >= 6:
        return _ALLOWED_SHORT_ES.get(phrase, "")
    return translated_clean


def is_recent_duplicate(conversation_id: str | None, text: str) -> bool:
    """Drop the same line if Whisper spam-repeats it within a few seconds."""
    if not conversation_id:
        return False
    phrase = _normalize_phrase(text)
    if not phrase:
        return False
    now = time.monotonic()
    # Prune stale keys opportunistically.
    stale = [key for key, (_, seen_at) in _RECENT_LINES.items() if now - seen_at > _RECENT_TTL_SEC * 3]
    for key in stale:
        _RECENT_LINES.pop(key, None)
    previous = _RECENT_LINES.get(conversation_id)
    if previous and previous[0] == phrase and (now - previous[1]) <= _RECENT_TTL_SEC:
        return True
    _RECENT_LINES[conversation_id] = (phrase, now)
    return False
