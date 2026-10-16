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


def resolve_speech_api_key() -> str:
    return (settings.speech_api_key or settings.ai_api_key or "").strip()


def resolve_speech_provider_name(requested: str | None = None) -> str:
    name = (requested or settings.speech_provider or "auto").strip().lower()
    if name in {"openai", "cloud"}:
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
    """OpenAI cloud transcription — typically 1–3s vs minutes on free-tier local Whisper."""

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
        api_key = resolve_speech_api_key()
        if not api_key:
            raise RuntimeError("SPEECH_API_KEY or AI_API_KEY is required for cloud speech transcription.")
        try:
            from openai import OpenAI
        except ImportError as exc:
            raise RuntimeError("Install backend requirements to enable OpenAI cloud speech.") from exc

        client = OpenAI(api_key=api_key)
        model = settings.speech_cloud_model
        hint = normalize_supported_language(language_hint)
        path = Path(audio_path)
        filename = path.name or f"audio{path.suffix or '.webm'}"
        with path.open("rb") as audio_file:
            kwargs: dict = {
                "model": model,
                "file": (filename, audio_file),
            }
            if model.startswith("whisper"):
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
        logger.info("Cloud STT complete model=%s language=%s chars=%s", model, language, len(original))
        return SpeechResult(original, language, original, 0.92, True, "spk-unassigned")


_speech_provider_cache: dict[str, SpeechProvider] = {}


def get_speech_provider(name: str | None = None) -> SpeechProvider:
    resolved = resolve_speech_provider_name(name)
    cached = _speech_provider_cache.get(resolved)
    if cached is not None:
        return cached
    mapping = {
        "mock": MockSpeechProvider,
        "whisper": WhisperSpeechProvider,
        "cloud": CloudSpeechProvider,
        "openai": CloudSpeechProvider,
    }
    provider_cls = mapping.get(resolved)
    if provider_cls is None:
        raise ValueError(f"Unsupported SPEECH_PROVIDER: {name or settings.speech_provider}.")
    instance = provider_cls()
    if resolved == "cloud":
        instance.name = "cloud"
    _speech_provider_cache[resolved] = instance
    logger.info("Speech provider ready requested=%s resolved=%s", name or settings.speech_provider, instance.name)
    return instance
