"""Transcript quality guards — reject Whisper hallucinations and non-EN/ES speech."""

from __future__ import annotations

import re
from collections import Counter

# Store capture only supports English and Spanish.
SUPPORTED_LANGUAGES = frozenset({"en", "es"})

# Classic Whisper empty-audio / YouTube hallucinations.
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
)

_WORD_RE = re.compile(r"[a-záéíóúüñ']+", re.IGNORECASE)


def normalize_language(language: str | None) -> str | None:
    if not language:
        return None
    code = language.lower().replace("_", "-").split("-")[0]
    return code if code in SUPPORTED_LANGUAGES else None


def _normalize_phrase(text: str) -> str:
    cleaned = re.sub(r"[^\w\s]", " ", (text or "").lower(), flags=re.UNICODE)
    return " ".join(cleaned.split())


def looks_like_spanish(text: str) -> bool:
    lowered = (text or "").lower()
    if any(marker in lowered for marker in ("¿", "¡", "ñ", "á", "é", "í", "ó", "ú", "ü")):
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
    )
    words = set(_WORD_RE.findall(lowered))
    return sum(1 for token in spanish_hits if token in words or token in lowered) >= 2


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

    words = _WORD_RE.findall(phrase)
    if not words:
        return True

    # "Thank you. Thank you. Thank you." / single-token spam
    counts = Counter(word.lower() for word in words)
    top_word, top_count = counts.most_common(1)[0]
    if top_word in {"thank", "thanks", "you", "bye", "okay", "ok", "uh", "um", "ah"} and top_count >= 3:
        return True
    if len(words) >= 4 and top_count / len(words) >= 0.6 and top_word in {"thank", "thanks", "you"}:
        return True
    if len(set(w.lower() for w in words)) == 1 and len(words) >= 2:
        return True

    # Extreme repetition of a short 1–2 word phrase
    if len(words) >= 6:
        unique_ratio = len(set(w.lower() for w in words)) / len(words)
        if unique_ratio <= 0.25:
            return True
    return False


def sanitize_transcript(text: str) -> str:
    cleaned = " ".join((text or "").split()).strip(" \t\n\r.-")
    return cleaned
