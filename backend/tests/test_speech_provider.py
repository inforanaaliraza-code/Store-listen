from __future__ import annotations

import app.providers.speech as speech_module
from app.providers.speech import (
    CloudSpeechProvider,
    WhisperSpeechProvider,
    get_speech_provider,
    resolve_speech_api_key,
    resolve_speech_provider_name,
)


def _clear_provider_cache() -> None:
    speech_module._speech_provider_cache.clear()


def test_auto_resolves_to_cloud_when_api_key_present(monkeypatch) -> None:
    monkeypatch.setattr(speech_module.settings, "speech_provider", "auto")
    monkeypatch.setattr(speech_module.settings, "speech_api_key", "")
    monkeypatch.setattr(speech_module.settings, "ai_api_key", "sk-test-key")
    _clear_provider_cache()
    assert resolve_speech_api_key() == "sk-test-key"
    assert resolve_speech_provider_name() == "cloud"
    provider = get_speech_provider()
    assert isinstance(provider, CloudSpeechProvider)
    assert provider.name == "cloud"


def test_auto_falls_back_to_whisper_without_key(monkeypatch) -> None:
    monkeypatch.setattr(speech_module.settings, "speech_provider", "auto")
    monkeypatch.setattr(speech_module.settings, "speech_api_key", "")
    monkeypatch.setattr(speech_module.settings, "ai_api_key", "")
    _clear_provider_cache()
    assert resolve_speech_provider_name() == "whisper"
    provider = get_speech_provider()
    assert isinstance(provider, WhisperSpeechProvider)


def test_openai_alias_uses_cloud_provider(monkeypatch) -> None:
    monkeypatch.setattr(speech_module.settings, "speech_provider", "openai")
    monkeypatch.setattr(speech_module.settings, "ai_api_key", "sk-test-key")
    _clear_provider_cache()
    assert resolve_speech_provider_name("openai") == "cloud"
    assert get_speech_provider("openai").name == "cloud"
