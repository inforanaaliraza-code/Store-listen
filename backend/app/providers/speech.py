from __future__ import annotations

import logging
import os
import tempfile
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

from app.config import settings

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
        super().__init__(f"Only English, Spanish, Hindi, Urdu, and Arabic speech is supported; detected {language}.")


SUPPORTED_LANGUAGES = frozenset({"en", "es", "hi", "ur", "ar"})


def normalize_supported_language(language: str | None) -> str | None:
    if not language:
        return None
    code = language.lower().replace("_", "-").split("-")[0]
    return code if code in SUPPORTED_LANGUAGES else None


GROQ_OPENAI_BASE_URL = "https://api.groq.com/openai/v1"
GROQ_DEFAULT_MODEL = "whisper-large-v3-turbo"
OPENAI_DEFAULT_MODEL = "gpt-4o-mini-transcribe"


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

    # auto prefers free Groq when GROQ_API_KEY is set; explicit openai forces OpenAI.
    use_groq = name == "groq" or (name in {"auto", "cloud"} and bool(groq_key))
    if use_groq and groq_key:
        model = configured_model if configured_model.startswith("whisper-large") else GROQ_DEFAULT_MODEL
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
        return {
            "language": normalize_supported_language(language_hint),
            "beam_size": settings.whisper_beam_size,
            "best_of": 1,
            "temperature": 0.0,
            "vad_filter": False,
            "without_timestamps": True,
            "condition_on_previous_text": False,
            "word_timestamps": False,
            "compression_ratio_threshold": 2.4,
            "no_speech_threshold": 0.55,
            "patience": 0.8,
        }

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
        if not original:
            raise NoSpeechDetected("No speech was detected in this audio clip.")
        confidence = sum(segment.avg_logprob for segment in segment_list) / len(segment_list)
        confidence = max(0.0, min(1.0, 2.71828**confidence))
        language = normalize_supported_language(info.language)
        if language is None:
            raise UnsupportedLanguageDetected(info.language or "und")
        translated = original
        if language == "es" and settings.whisper_translate_spanish:
            translations, _ = model.transcribe(
                str(audio_path),
                task="translate",
                **self._transcribe_kwargs(language),
            )
            translated = " ".join(segment.text.strip() for segment in translations).strip() or original
        return SpeechResult(original, language, translated, confidence, True, "spk-unassigned")


class CloudSpeechProvider(SpeechProvider):
    """Cloud transcription via Groq (free) or OpenAI — typically 1–3s vs minutes on free CPUs."""

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

    def transcribe_file(self, audio_path: str | Path, language_hint: str | None = None) -> SpeechResult:
        if language_hint and not normalize_supported_language(language_hint):
            raise UnsupportedLanguageDetected(language_hint)
        config = resolve_speech_cloud_config()
        api_key = config["api_key"]
        if not api_key:
            raise RuntimeError(
                "GROQ_API_KEY (free) or SPEECH_API_KEY / AI_API_KEY is required for cloud speech transcription."
            )
        try:
            from openai import OpenAI
        except ImportError as exc:
            raise RuntimeError("Install backend requirements to enable cloud speech.") from exc

        client_kwargs: dict = {"api_key": api_key}
        if config["base_url"]:
            client_kwargs["base_url"] = config["base_url"]
        client = OpenAI(**client_kwargs)
        model = config["model"]
        hint = normalize_supported_language(language_hint)
        path = Path(audio_path)
        filename = path.name or f"audio{path.suffix or '.webm'}"
        with path.open("rb") as audio_file:
            kwargs: dict = {
                "model": model,
                "file": (filename, audio_file),
            }
            if "whisper" in model:
                kwargs["response_format"] = "verbose_json"
            else:
                kwargs["response_format"] = "json"
            if hint:
                kwargs["language"] = hint
            try:
                result = client.audio.transcriptions.create(**kwargs)
            except Exception:
                # Some models reject language/response_format; retry with bare payload.
                audio_file.seek(0)
                kwargs = {"model": model, "file": (filename, audio_file)}
                result = client.audio.transcriptions.create(**kwargs)
        original = (getattr(result, "text", None) or str(result or "")).strip()
        language = normalize_supported_language(getattr(result, "language", None) or hint)

        if not original:
            raise NoSpeechDetected("No speech was detected in this audio clip.")
        if language is None:
            language = "en"
        if language not in SUPPORTED_LANGUAGES:
            raise UnsupportedLanguageDetected(language)
        self.name = config["label"] or "cloud"
        logger.info(
            "Cloud STT complete backend=%s model=%s language=%s chars=%s",
            self.name,
            model,
            language,
            len(original),
        )
        return SpeechResult(original, language, original, 0.92, True, "spk-unassigned")


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
