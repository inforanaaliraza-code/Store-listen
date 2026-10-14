from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path


class AudioSource(ABC):
    name = "abstract"

    @abstractmethod
    def read_chunk(self) -> bytes:
        raise NotImplementedError


class MockAudioSource(AudioSource):
    name = "mock"

    def __init__(self, phrases: list[str] | None = None):
        self.phrases = phrases or ["¿Tiene un cargador para iPhone?"]
        self.index = 0

    def read_chunk(self) -> bytes:
        phrase = self.phrases[self.index % len(self.phrases)]
        self.index += 1
        return phrase.encode("utf-8")


class FileAudioSource(AudioSource):
    name = "file"

    def __init__(self, path: str):
        self.path = Path(path)

    def read_chunk(self) -> bytes:
        if not self.path.exists():
            return b""
        return self.path.read_bytes()[:4096]


class MicrophoneAudioSource(AudioSource):
    name = "microphone"

    def read_chunk(self) -> bytes:
        raise RuntimeError("Microphone capture is available at the store agent boundary; it is not required for local demo.")
