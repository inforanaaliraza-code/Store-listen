from __future__ import annotations

import logging
import os
import tempfile
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

from app.config import settings
from app.providers.speech_quality import (
    SUPPORTED_LANGUAGES,
    is_hallucinated_transcript,
    is_usable_english_translation,
    looks_like_spanish,
    normalize_language,
    polish_spanish_translation,
    sanitize_transcript,
)

logger = logging.getLogger("storelisten.speech")


@dataclass
class SpeechResult:
    original_text: str
    language: str
    translated_text: str
    confidence: float
    is_final: bool
    speaker_id: str = "spk-unknown"


class SpeechProvider(ABC):
    name = "abstract"

    @abstractmethod
    def transcribe(self, audio_chunk: bytes, language_hint: str | None = None) -> SpeechResult:
        raise NotImplementedError

    def transcribe_file(self, audio_path: str | Path, language_hint: str | None = None) -> SpeechResult:
        return self.transcribe(Path(audio_path).read_bytes(), language_hint)


class NoSpeechDetected(ValueError):
    pass


class UnsupportedLanguageDetected(ValueError):
    def __init__(self, language: str):
        self.language = language
        super().__init__(f"Only English and Spanish speech is supported; detected {language}.")


def normalize_supported_language(language: str | None) -> str | None:
    return normalize_language(language)


GROQ_OPENAI_BASE_URL = "https://api.groq.com/openai/v1"
GROQ_DEFAULT_MODEL = "whisper-large-v3"
GROQ_TRANSLATE_MODEL = "whisper-large-v3"
OPENAI_DEFAULT_MODEL = "gpt-4o-mini-transcribe"

# Do not send instructional prompt text — Whisper often echoes it into the transcript.
_STT_PROMPT = ""


def resolve_speech_api_key() -> str:
    """Prefer free Groq, then dedicated speech key, then shared AI key."""
    return (settings.groq_api_key or settings.speech_api_key or settings.ai_api_key or "").strip()


def resolve_speech_cloud_config(requested: str | None = None) -> dict[str, str]:
    """Return api_key, base_url, model, and label for the active cloud STT backend."""
    name = (requested or settings.speech_provider or "auto").strip().lower()
    groq_key = (settings.groq_api_key or "").strip()
    openai_key = (settings.speech_api_key or settings.ai_api_key or "").strip()
    custom_base = (settings.speech_cloud_base_url or "").strip()
    configured_model = (settings.speech_cloud_model or "").strip()

    use_groq = name == "groq" or (name in {"auto", "cloud"} and bool(groq_key))
    if use_groq and groq_key:
        model = configured_model if configured_model.startswith("whisper-large") else GROQ_DEFAULT_MODEL
        # Prefer full v3 over turbo for store accuracy (fewer hallucinations).
        if model == "whisper-large-v3-turbo":
            model = GROQ_DEFAULT_MODEL
        return {
            "label": "groq",
            "api_key": groq_key,
            "base_url": custom_base or GROQ_OPENAI_BASE_URL,
            "model": model,
        }

    if openai_key:
        model = configured_model
        if not model or model.startswith("whisper-large"):
            model = OPENAI_DEFAULT_MODEL
        return {
            "label": "openai",
            "api_key": openai_key,
            "base_url": custom_base,
            "model": model,
        }

    return {"label": "", "api_key": "", "base_url": "", "model": ""}


def resolve_speech_provider_name(requested: str | None = None) -> str:
    name = (requested or settings.speech_provider or "auto").strip().lower()
    if name in {"openai", "cloud", "groq"}:
        return "cloud" if resolve_speech_api_key() else "whisper"
    if name == "auto":
        return "cloud" if resolve_speech_api_key() else "whisper"
    return name


def _finalize_transcript(original: str, language: str | None, hint: str | None) -> tuple[str, str]:
    text = sanitize_transcript(original)
    if not text or is_hallucinated_transcript(text):
        raise NoSpeechDetected("No clear English or Spanish speech was detected in this audio clip.")

    # Short clear Spanish store phrases win over a wrong Whisper language tag (e.g. Gracias→en).
    if looks_like_spanish(text):
        return text, "es"

    raw = (language or "").lower().replace("_", "-").split("-")[0] if language else None
    if raw and raw not in SUPPORTED_LANGUAGES and raw not in {"und", "auto", ""}:
        raise UnsupportedLanguageDetected(raw)

    detected = normalize_supported_language(language) or hint or "en"
    if detected not in SUPPORTED_LANGUAGES:
        raise UnsupportedLanguageDetected(detected)
    return text, detected


class MockSpeechProvider(SpeechProvider):
    name = "mock"

    def transcribe(self, audio_chunk: bytes, language_hint: str | None = None) -> SpeechResult:
        if language_hint and not normalize_supported_language(language_hint):
            raise UnsupportedLanguageDetected(language_hint)
        text = audio_chunk.decode("utf-8", errors="ignore") or "..."
        language = normalize_supported_language(language_hint) or ("es" if any(ch in text.lower() for ch in ("¿", "ñ", "cargador", "tiene")) else "en")
        translated = text
        if language == "es" and "cargador" in text.lower():
            translated = "Do you have an iPhone charger?" if "iphone" in text.lower() else "Do you have a charger?"
        return SpeechResult(text, language, translated, 0.93, True, "spk-1")


class WhisperSpeechProvider(SpeechProvider):
    """Local faster-whisper inference. Slow on tiny free CPUs; prefer cloud when keyed."""

    name = "whisper"
    _model = None

    @classmethod
    def _get_model(cls):
        if cls._model is None:
            try:
                import av
            except ImportError:
                av = None
            if av is not None:
                _original_open = av.open

                def _compatible_open(*args, **kwargs):
                    kwargs.pop("metadata_errors", None)
                    return _original_open(*args, **kwargs)

                av.open = _compatible_open
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:
                raise RuntimeError("Install backend requirements to enable local faster-whisper.") from exc
            cls._model = WhisperModel(
                settings.whisper_model,
                device=settings.whisper_device,
                compute_type=settings.whisper_compute_type,
                cpu_threads=settings.whisper_cpu_threads,
                num_workers=settings.whisper_num_workers,
            )
        return cls._model

    @classmethod
    def warm_up(cls) -> None:
        if resolve_speech_provider_name() != "whisper":
            logger.info("Skipping Whisper warm-up; active speech provider is not local whisper")
            return
        try:
            cls._get_model()
            logger.info(
                "Whisper warm-up complete model=%s device=%s compute=%s",
                settings.whisper_model,
                settings.whisper_device,
                settings.whisper_compute_type,
            )
        except Exception:
            logger.warning("Whisper warm-up failed; first transcription may be slower", exc_info=True)

    @staticmethod
    def _transcribe_kwargs(language_hint: str | None) -> dict:
        kwargs = {
            "language": normalize_supported_language(language_hint),
            "beam_size": settings.whisper_beam_size,
            "best_of": 1,
            "temperature": 0.0,
            "vad_filter": True,
            "without_timestamps": True,
            "condition_on_previous_text": False,
            "word_timestamps": False,
            "compression_ratio_threshold": 2.2,
            "no_speech_threshold": 0.65,
            "patience": 0.8,
        }
        if _STT_PROMPT:
            kwargs["initial_prompt"] = _STT_PROMPT
        return kwargs

    def transcribe(self, audio_chunk: bytes, language_hint: str | None = None) -> SpeechResult:
        suffix = ".webm"
        fd, path = tempfile.mkstemp(suffix=suffix)
        try:
            with os.fdopen(fd, "wb") as audio_file:
                audio_file.write(audio_chunk)
                audio_file.flush()
            return self.transcribe_file(path, language_hint)
        finally:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass

    def transcribe_file(self, audio_path: str | Path, language_hint: str | None = None) -> SpeechResult:
        if language_hint and not normalize_supported_language(language_hint):
            raise UnsupportedLanguageDetected(language_hint)
        model = self._get_model()
        segments, info = model.transcribe(str(audio_path), **self._transcribe_kwargs(language_hint))
        segment_list = list(segments)
        original = " ".join(segment.text.strip() for segment in segment_list).strip()
        original, language = _finalize_transcript(original, getattr(info, "language", None), language_hint)
        confidence = sum(segment.avg_logprob for segment in segment_list) / max(len(segment_list), 1)
        confidence = max(0.0, min(1.0, 2.71828**confidence))
        translated = original
        if settings.whisper_translate_spanish and (language == "es" or looks_like_spanish(original)):
            language = "es"
            translations, _ = model.transcribe(
                str(audio_path),
                task="translate",
                **{**self._transcribe_kwargs("en"), "language": "en"},
            )
            polished = polish_spanish_translation(
                original,
                sanitize_transcript(" ".join(segment.text.strip() for segment in translations)),
            )
            translated = polished if is_usable_english_translation(original, polished) else ""
        return SpeechResult(original, language, translated, confidence, True, "spk-unassigned")


class CloudSpeechProvider(SpeechProvider):
    """Cloud transcription via Groq (free) or OpenAI — EN/ES only with Spanish→English."""

    name = "cloud"

    def transcribe(self, audio_chunk: bytes, language_hint: str | None = None) -> SpeechResult:
        suffix = ".webm"
        fd, path = tempfile.mkstemp(suffix=suffix)
        try:
            with os.fdopen(fd, "wb") as audio_file:
                audio_file.write(audio_chunk)
                audio_file.flush()
            return self.transcribe_file(path, language_hint)
        finally:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass

    def _openai_client(self, config: dict[str, str]):
        from openai import OpenAI

        client_kwargs: dict = {"api_key": config["api_key"]}
        if config["base_url"]:
            client_kwargs["base_url"] = config["base_url"]
        return OpenAI(**client_kwargs)

    def _transcribe_once(self, client, model: str, path: Path, *, language: str | None) -> tuple[str, str | None]:
        filename = path.name or f"audio{path.suffix or '.webm'}"
        with path.open("rb") as audio_file:
            kwargs: dict = {
                "model": model,
                "file": (filename, audio_file),
                "temperature": 0,
            }
            if _STT_PROMPT:
                kwargs["prompt"] = _STT_PROMPT
            if "whisper" in model:
                kwargs["response_format"] = "verbose_json"
            else:
                kwargs["response_format"] = "json"
            if language in {"en", "es"}:
                kwargs["language"] = language
            try:
                result = client.audio.transcriptions.create(**kwargs)
            except Exception:
                audio_file.seek(0)
                bare = {"model": model, "file": (filename, audio_file), "temperature": 0}
                if language in {"en", "es"}:
                    bare["language"] = language
                result = client.audio.transcriptions.create(**bare)
        text = sanitize_transcript(getattr(result, "text", None) or "")
        detected = normalize_supported_language(getattr(result, "language", None) or language)
        return text, detected

    def _chat_translate_spanish(self, client, config: dict[str, str], spanish_text: str) -> str:
        from app.providers.groq_chat import groq_chat_completion

        messages = [
            {
                "role": "system",
                "content": (
                    "Translate the customer's Spanish retail-store speech into clear, concise English "
                    "for store staff who do not speak Spanish. "
                    "Return only the English translation, no quotes or commentary."
                ),
            },
            {"role": "user", "content": spanish_text},
        ]
        if config["label"] == "groq":
            completion = groq_chat_completion(client, messages=messages)
        else:
            completion = client.chat.completions.create(model="gpt-4o-mini", temperature=0, messages=messages)
        return sanitize_transcript(completion.choices[0].message.content or "")

    def _translate_to_english(self, client, config: dict[str, str], path: Path, spanish_text: str) -> str:
        """Translate the transcript text. A second Whisper pass hears the clip differently and slows the line."""
        del path
        try:
            translated = self._chat_translate_spanish(client, config, spanish_text)
            if is_usable_english_translation(spanish_text, translated):
                return translated
        except Exception:
            logger.warning("Text translation fallback failed", exc_info=True)
        return ""

    def transcribe_file(self, audio_path: str | Path, language_hint: str | None = None, *, fast: bool = False) -> SpeechResult:
        if language_hint and not normalize_supported_language(language_hint):
            raise UnsupportedLanguageDetected(language_hint)
        config = resolve_speech_cloud_config()
        if not config["api_key"]:
            raise RuntimeError(
                "GROQ_API_KEY (free) or SPEECH_API_KEY / AI_API_KEY is required for cloud speech transcription."
            )
        try:
            from openai import OpenAI  # noqa: F401
        except ImportError as exc:
            raise RuntimeError("Install backend requirements to enable cloud speech.") from exc

        client = self._openai_client(config)
        model = config["model"]
        if fast and config["label"] == "groq":
            model = "whisper-large-v3-turbo"
        hint = normalize_supported_language(language_hint)
        path = Path(audio_path)

        # Auto-detect first unless the operator forced EN/ES.
        # Never retry on hallucinated filler (Tchau/Obrigado/Thank you) — a second pass
        # on the same noise usually invents a different fake word.
        original, detected = self._transcribe_once(client, model, path, language=hint)
        if not original and hint is None and not fast:
            alt_text, alt_lang = self._transcribe_once(client, model, path, language="es")
            if alt_text and not is_hallucinated_transcript(alt_text):
                original, detected = alt_text, alt_lang or "es"

        original, language = _finalize_transcript(original, detected, hint)
        translated = original
        # Live previews skip EN gloss so words appear immediately; finals still translate Spanish.
        if (
            not fast
            and settings.whisper_translate_spanish
            and (language == "es" or looks_like_spanish(original))
        ):
            language = "es"
            polished = polish_spanish_translation(
                original,
                self._translate_to_english(client, config, path, original),
            )
            if polished:
                translated = polished
            else:
                # Last-resort chat pass if audio translate echoed Spanish or returned junk.
                try:
                    retry = polish_spanish_translation(
                        original,
                        self._chat_translate_spanish(client, config, original),
                    )
                    translated = retry or ""
                except Exception:
                    translated = ""
            # Never leave Spanish in the English field — staff must see EN or an empty pending line.
            if not is_usable_english_translation(original, translated):
                translated = ""

        self.name = config["label"] or "cloud"
        logger.info(
            "Cloud STT complete backend=%s model=%s language=%s chars=%s translated=%s fast=%s",
            self.name,
            model,
            language,
            len(original),
            language == "es" and translated != original,
            fast,
        )
        return SpeechResult(original, language, translated, 0.92, True, "spk-unassigned")


_speech_provider_cache: dict[str, SpeechProvider] = {}


def get_speech_provider(name: str | None = None) -> SpeechProvider:
    resolved = resolve_speech_provider_name(name)
    cache_key = resolved
    if resolved == "cloud":
        cache_key = f"cloud:{resolve_speech_cloud_config(name)['label']}"
    cached = _speech_provider_cache.get(cache_key)
    if cached is not None:
        return cached
    mapping = {
        "mock": MockSpeechProvider,
        "whisper": WhisperSpeechProvider,
        "cloud": CloudSpeechProvider,
        "openai": CloudSpeechProvider,
        "groq": CloudSpeechProvider,
    }
    provider_cls = mapping.get(resolved)
    if provider_cls is None:
        raise ValueError(f"Unsupported SPEECH_PROVIDER: {name or settings.speech_provider}.")
    instance = provider_cls()
    if resolved == "cloud":
        instance.name = resolve_speech_cloud_config(name)["label"] or "cloud"
    _speech_provider_cache[cache_key] = instance
    logger.info("Speech provider ready requested=%s resolved=%s", name or settings.speech_provider, instance.name)
    return instance
