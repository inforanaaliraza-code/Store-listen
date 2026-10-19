from __future__ import annotations

from types import SimpleNamespace

import app.providers.speech as speech_module
from app.providers.speech import (
    GROQ_DEFAULT_MODEL,
    GROQ_OPENAI_BASE_URL,
    CloudSpeechProvider,
    WhisperSpeechProvider,
    get_speech_provider,
    resolve_speech_api_key,
    resolve_speech_cloud_config,
    resolve_speech_provider_name,
)
from app.providers.ai import MockAIProvider


def _clear_provider_cache() -> None:
    speech_module._speech_provider_cache.clear()


def test_auto_prefers_free_groq_when_key_present(monkeypatch) -> None:
    monkeypatch.setattr(speech_module.settings, "speech_provider", "auto")
    monkeypatch.setattr(speech_module.settings, "groq_api_key", "gsk-test")
    monkeypatch.setattr(speech_module.settings, "speech_api_key", "")
    monkeypatch.setattr(speech_module.settings, "ai_api_key", "sk-openai")
    monkeypatch.setattr(speech_module.settings, "speech_cloud_model", "whisper-large-v3-turbo")
    monkeypatch.setattr(speech_module.settings, "speech_cloud_base_url", "")
    _clear_provider_cache()
    assert resolve_speech_api_key() == "gsk-test"
    assert resolve_speech_provider_name() == "cloud"
    config = resolve_speech_cloud_config()
    assert config["label"] == "groq"
    assert config["base_url"] == GROQ_OPENAI_BASE_URL
    assert config["model"] == GROQ_DEFAULT_MODEL
    provider = get_speech_provider()
    assert isinstance(provider, CloudSpeechProvider)
    assert provider.name == "groq"


def test_auto_uses_openai_when_only_openai_key(monkeypatch) -> None:
    monkeypatch.setattr(speech_module.settings, "speech_provider", "auto")
    monkeypatch.setattr(speech_module.settings, "groq_api_key", "")
    monkeypatch.setattr(speech_module.settings, "speech_api_key", "")
    monkeypatch.setattr(speech_module.settings, "ai_api_key", "sk-test-key")
    monkeypatch.setattr(speech_module.settings, "speech_cloud_model", "whisper-large-v3-turbo")
    monkeypatch.setattr(speech_module.settings, "speech_cloud_base_url", "")
    _clear_provider_cache()
    assert resolve_speech_api_key() == "sk-test-key"
    config = resolve_speech_cloud_config()
    assert config["label"] == "openai"
    assert config["model"] == "gpt-4o-mini-transcribe"
    provider = get_speech_provider()
    assert provider.name == "openai"


def test_auto_falls_back_to_whisper_without_key(monkeypatch) -> None:
    monkeypatch.setattr(speech_module.settings, "speech_provider", "auto")
    monkeypatch.setattr(speech_module.settings, "groq_api_key", "")
    monkeypatch.setattr(speech_module.settings, "speech_api_key", "")
    monkeypatch.setattr(speech_module.settings, "ai_api_key", "")
    _clear_provider_cache()
    assert resolve_speech_provider_name() == "whisper"
    provider = get_speech_provider()
    assert isinstance(provider, WhisperSpeechProvider)


def test_openai_alias_uses_cloud_provider(monkeypatch) -> None:
    monkeypatch.setattr(speech_module.settings, "speech_provider", "openai")
    monkeypatch.setattr(speech_module.settings, "groq_api_key", "")
    monkeypatch.setattr(speech_module.settings, "ai_api_key", "sk-test-key")
    monkeypatch.setattr(speech_module.settings, "speech_cloud_model", "gpt-4o-mini-transcribe")
    monkeypatch.setattr(speech_module.settings, "speech_cloud_base_url", "")
    _clear_provider_cache()
    assert resolve_speech_provider_name("openai") == "cloud"
    assert get_speech_provider("openai").name == "openai"


def test_cloud_provider_translates_mixed_spanish_once_even_when_stt_reports_english(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(speech_module.settings, "speech_provider", "auto")
    monkeypatch.setattr(speech_module.settings, "groq_api_key", "groq-test-key")
    monkeypatch.setattr(speech_module.settings, "speech_api_key", "")
    monkeypatch.setattr(speech_module.settings, "ai_api_key", "")
    monkeypatch.setattr(speech_module.settings, "speech_cloud_model", "whisper-large-v3")
    calls = {"transcription": 0, "translation": 0}

    class Transcriptions:
        def create(self, **_kwargs):
            calls["transcription"] += 1
            return SimpleNamespace(
                text=(
                    "What is the accent of Barcelona in Spanish? I think it is more open. "
                    "Yo me acuerdo que fui un dia a Madrid con amigas, que era con el core, "
                    "y nos dijeron, eran bien los clientes de Madrid."
                ),
                language="en",
            )

    class Completions:
        def create(self, **_kwargs):
            calls["translation"] += 1
            message = SimpleNamespace(content="I remember going to Madrid with friends; the customers there were very kind.")
            return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    client = SimpleNamespace(
        audio=SimpleNamespace(transcriptions=Transcriptions()),
        chat=SimpleNamespace(completions=Completions()),
    )
    monkeypatch.setattr(CloudSpeechProvider, "_openai_client", lambda _self, _config: client)
    path = tmp_path / "mixed-spanish.webm"
    path.write_bytes(b"fake audio")

    result = CloudSpeechProvider().transcribe_file(path)

    assert result.language == "es"
    assert result.translated_text == "I remember going to Madrid with friends; the customers there were very kind"
    assert calls == {"transcription": 1, "translation": 1}


def test_mock_live_coaching_gives_a_careful_model_specific_reply():
    result = MockAIProvider().analyze(
        "Recent turn 1: Do you have the iPhone 18 Pro Max in stock?",
        "Recent turn 1: Do you have the iPhone 18 Pro Max in stock?",
        "en",
        "unknown",
    )

    assert result.product == "iPhone 18 Pro Max"
    assert "iPhone 18 Pro Max" in result.recommendation
    assert "before i promise availability" in result.recommendation.lower()
