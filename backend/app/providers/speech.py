from __future__ import annotations

import os
import tempfile
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

from app.config import settings


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
    """Local faster-whisper inference; model files are downloaded on first use."""

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
            )
        return cls._model

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
        segments, info = model.transcribe(
            str(audio_path),
            language=normalize_supported_language(language_hint),
            beam_size=settings.whisper_beam_size,
            vad_filter=False,
            without_timestamps=True,
            condition_on_previous_text=False,
        )
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
                language=language,
                beam_size=settings.whisper_beam_size,
                vad_filter=False,
                without_timestamps=True,
                condition_on_previous_text=False,
            )
            translated = " ".join(segment.text.strip() for segment in translations).strip() or original
        return SpeechResult(original, language, translated, confidence, True, "spk-unassigned")


class CloudSpeechProvider(SpeechProvider):
    name = "cloud"

    def transcribe(self, audio_chunk: bytes, language_hint: str | None = None) -> SpeechResult:
        raise RuntimeError("Cloud speech provider is not configured.")


def get_speech_provider(name: str) -> SpeechProvider:
    mapping = {
        "mock": MockSpeechProvider,
        "whisper": WhisperSpeechProvider,
        "cloud": CloudSpeechProvider,
    }
    provider = mapping.get(name)
    if provider is None:
        raise ValueError(f"Unsupported SPEECH_PROVIDER: {name}.")
    return provider()
