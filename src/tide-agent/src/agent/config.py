"""Validated environment configuration.

`Settings()` itself never fails on missing credentials, so tests can build
it freely. The app's startup calls `require_runtime_config()`, which fails
loudly unless the LLM is fully configured or `LLM_FAKE=1` is set explicitly:
there is no silent fallback to the fake model.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Central .env file in the repo root (shared across all services).
_ROOT_ENV_FILE = Path(__file__).resolve().parents[4] / ".env"

# Chat app id -> its CAP MCP endpoint path.
APP_MCP_PATHS = {
    "cockpit": "cockpit",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_ROOT_ENV_FILE, env_file_encoding="utf-8", extra="ignore"
    )

    # --- LLM (litellm model string + key; agent's own reasoning model) ---
    # api_base/api_version are only required for Azure-routed models (Azure
    # OpenAI `azure/<deployment>` needs both; Azure AI Foundry `azure_ai/<model>`
    # needs only api_base) - leave unset for plain OpenAI/Anthropic/etc.
    agent_model: str | None = None
    agent_model_api_key: str | None = None
    agent_model_api_base: str | None = None
    agent_model_api_version: str | None = None
    llm_fake: bool = False

    # --- CAP: one MCP endpoint per chat app plus the runtime REST service ---
    # Also used to verify every caller: CAP is the only authority on users.
    cap_url: str = "http://localhost:4004"
    mcp_timeout_seconds: float = Field(default=30.0, gt=0)
    # How long an accepted Authorization header is trusted without asking CAP.
    auth_cache_seconds: float = Field(default=60.0, ge=0)

    # --- Checkpoints (conversation state only; never credentials) ---
    checkpoint_db: str = ".data/checkpoints.sqlite"

    # --- Budget: bounds a runaway tool-call loop / cost per turn ---
    max_steps: int = Field(default=8, gt=0)
    max_tool_calls: int = Field(default=16, gt=0)
    # Conversation kept per thread (approximate tokens); older exchanges are dropped.
    max_history_tokens: int = Field(default=60_000, gt=0)
    # Longer tool results are cut before they reach the LLM and the thread.
    max_tool_result_chars: int = Field(default=20_000, gt=0)
    turn_timeout_s: float = Field(default=60.0, gt=0)

    # --- Overload protection ---
    max_concurrent_turns: int = Field(default=50, gt=0)
    max_request_bytes: int = Field(default=1_048_576, gt=0)
    max_input_messages: int = Field(default=200, gt=0)
    max_message_chars: int = Field(default=16_000, gt=0)
    model_context_tokens: int = Field(default=128_000, gt=0)
    max_output_tokens: int = Field(default=4096, gt=0)
    prompt_safety_tokens: int = Field(default=2048, ge=0)

    @model_validator(mode="after")
    def validate_prompt_budget(self) -> Settings:
        if self.model_context_tokens <= self.max_output_tokens + self.prompt_safety_tokens:
            raise ValueError("model context must exceed the output reserve and safety margin")
        return self

    @property
    def max_prompt_tokens(self) -> int:
        return self.model_context_tokens - self.max_output_tokens - self.prompt_safety_tokens

    def mcp_url(self, app_id: str) -> str:
        return f"{self.cap_url.rstrip('/')}/mcp/{APP_MCP_PATHS[app_id]}"

    @property
    def runtime_url(self) -> str:
        return f"{self.cap_url.rstrip('/')}/rest/assistant-runtime"

    # --- CORS (comma-separated origins) ---
    cors_origins: str = "http://localhost:4004,http://127.0.0.1:4004"

    host: str = Field(default="127.0.0.1", validation_alias="AGENT_HOST")
    port: int = Field(default=8081, validation_alias="AGENT_PORT")
    log_level: str = "INFO"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def has_llm_credentials(self) -> bool:
        """Whether the configured model has the credentials it needs."""
        return bool(self.agent_model and self.agent_model_api_key)

    def require_runtime_config(self) -> None:
        """Raise `ConfigError` naming every missing setting. Called at startup."""
        if self.llm_fake:
            return
        missing = [
            name
            for name, value in (
                ("AGENT_MODEL", self.agent_model),
                ("AGENT_MODEL_API_KEY", self.agent_model_api_key),
            )
            if not value
        ]
        if missing:
            raise ConfigError(
                f"agent is not configured, missing: {', '.join(missing)} "
                "(set LLM_FAKE=1 to run with the offline fake model)"
            )
        base = urlsplit(self.agent_model_api_base or "")
        if (
            self.agent_model != "openai/agent-reasoning"
            or base.scheme not in ("http", "https")
            or not base.hostname
            or base.path.rstrip("/") != "/v1"
            or base.username
            or base.password
            or base.query
            or base.fragment
        ):
            raise ConfigError(
                "Real mode requires openai/agent-reasoning through the configured "
                "gateway /v1 endpoint; use npm start."
            )


class ConfigError(RuntimeError):
    """Startup configuration is incomplete."""


@lru_cache
def get_settings() -> Settings:
    return Settings()
