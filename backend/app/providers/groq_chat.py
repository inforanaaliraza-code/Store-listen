"""Groq chat calls that survive model retirements.

llama-3.1-8b-instant is no longer on this account. Reports and Spanish
translation try the current chat models, then any other non-audio model
the key can see.
"""

from __future__ import annotations

GROQ_CHAT_MODELS = (
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b",
    "openai/gpt-oss-120b",
)

_SKIP_MODEL_MARKERS = ("whisper", "orpheus", "prompt-guard", "safeguard")


def _model_missing(exc: Exception) -> bool:
    text = str(exc).lower()
    return "model_not_found" in text or "does not exist" in text or "404" in text


def groq_chat_completion(client, *, messages: list[dict], response_format: dict | None = None, temperature: float = 0):
    errors: list[str] = []
    tried: list[str] = []
    for model in GROQ_CHAT_MODELS:
        tried.append(model)
        try:
            kwargs = {"model": model, "temperature": temperature, "messages": messages}
            if response_format is not None:
                kwargs["response_format"] = response_format
            return client.chat.completions.create(**kwargs)
        except Exception as exc:
            if not _model_missing(exc):
                raise
            errors.append(f"{model}: {exc}")

    try:
        listed = client.models.list()
        names = [item.id for item in getattr(listed, "data", [])]
    except Exception as exc:
        names = []
        errors.append(f"model list: {exc}")

    for name in names:
        if name in tried or any(marker in name for marker in _SKIP_MODEL_MARKERS):
            continue
        try:
            kwargs = {"model": name, "temperature": temperature, "messages": messages}
            if response_format is not None:
                kwargs["response_format"] = response_format
            return client.chat.completions.create(**kwargs)
        except Exception as exc:
            errors.append(f"{name}: {exc}")
            if not _model_missing(exc):
                break

    detail = " | ".join(errors[-3:]) or "no chat model returned a response"
    raise RuntimeError(f"No Groq chat model could answer. {detail}")
