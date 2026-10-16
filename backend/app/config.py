from pathlib import Path

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: str = "development"
    debug: bool = False
    mongodb_uri: str = ""
    mongo_database_name: str = "storelisten"
    redis_url: str = "redis://localhost:6379/0"
    redis_event_bus_enabled: bool = False
    api_base_url: str = "http://localhost:8000"
    web_base_url: str = "http://localhost:3000"
    jwt_secret: str = "dev-only-change-me"
    session_secret: str = "dev-only-change-me"
    demo_mode: bool = True
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000,https://localhost:3000,https://127.0.0.1:3000"
    cors_origin_regex: str = r"https://.*\.ts\.net$"
    ai_provider: str = "openai"
    ai_api_key: str = ""
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.5-flash-lite"
    speech_provider: str = "auto"
    speech_api_key: str = ""
    speech_cloud_model: str = "gpt-4o-mini-transcribe"
    whisper_model: str = "tiny"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    whisper_beam_size: int = Field(default=1, ge=1, le=5)
    whisper_cpu_threads: int = Field(default=2, ge=1, le=8)
    whisper_num_workers: int = Field(default=1, ge=1, le=4)
    whisper_translate_spanish: bool = False
    whisper_preview_enabled: bool = False
    whisper_warmup_on_start: bool = True
    pos_provider: str = "mock"
    pos_api_key: str = ""
    storage_provider: str = "local"
    audio_storage_dir: str = str(Path(__file__).resolve().parents[1] / "storage" / "audio")
    audio_retention_days: int = 7
    transcript_retention_days: int = 30
    rate_limit_per_minute: int = 120
    jwt_expire_minutes: int = 720

    model_config = SettingsConfigDict(
        env_file=str(Path(__file__).resolve().parents[2] / ".env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @model_validator(mode="after")
    def validate_production_configuration(self):
        if self.app_env.lower() != "production":
            return self
        if self.debug:
            raise ValueError("DEBUG must be false in production.")
        if self.demo_mode:
            raise ValueError("DEMO_MODE must be false in production.")
        mongo_uri = self.mongodb_uri.lower()
        if not mongo_uri.startswith("mongodb+srv://") or "tls=false" in mongo_uri or "ssl=false" in mongo_uri:
            raise ValueError("Production requires a valid TLS-enabled MongoDB MONGODB_URI.")
        for name, secret in (("JWT_SECRET", self.jwt_secret), ("SESSION_SECRET", self.session_secret)):
            lowered_secret = secret.lower()
            if len(secret) < 32 or any(marker in lowered_secret for marker in ("dev-only", "local-development", "change-me", "example")):
                raise ValueError(f"{name} must be a unique, randomly generated secret of at least 32 characters in production.")
        if self.jwt_secret == self.session_secret:
            raise ValueError("JWT_SECRET and SESSION_SECRET must be distinct values in production.")
        if not self.api_base_url.startswith("https://"):
            raise ValueError("API_BASE_URL must use HTTPS in production.")
        if not self.cors_origin_list or any(not origin.startswith("https://") for origin in self.cors_origin_list):
            raise ValueError("CORS_ORIGINS must contain only approved HTTPS origins in production.")
        if not self.redis_event_bus_enabled or not self.redis_url.startswith("rediss://"):
            raise ValueError("Production requires REDIS_EVENT_BUS_ENABLED=true and a TLS-protected REDIS_URL.")
        blockers = []
        if self.ai_provider == "mock" or (self.ai_provider in {"openai", "azure"} and not self.ai_api_key) or (self.ai_provider == "gemini" and not self.gemini_api_key):
            blockers.append("a configured real AI provider (mock analysis is not allowed)")
        if self.speech_provider not in {"whisper", "auto", "openai", "cloud"}:
            blockers.append("a supported speech provider (whisper, auto, or openai cloud)")
        elif self.speech_provider in {"auto", "openai", "cloud"} and not (self.speech_api_key or self.ai_api_key):
            blockers.append("SPEECH_API_KEY or AI_API_KEY for cloud speech (local Whisper alone is not production-grade)")
        if self.pos_provider == "mock":
            blockers.append("a confirmed real POS adapter (mock POS simulation is not allowed)")
        else:
            blockers.append(f"an implemented POS adapter for {self.pos_provider}")
        if self.storage_provider == "local":
            blockers.append("shared cloud object storage (local audio storage is not safe for multi-instance deployment)")
        else:
            blockers.append(f"an implemented shared audio storage adapter for {self.storage_provider}")
        if blockers:
            raise ValueError("Production launch is blocked until these requirements are implemented/configured: " + "; ".join(blockers) + ".")
        return self

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


settings = Settings()
