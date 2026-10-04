"""Validated environment configuration.

`Settings()` never fails on missing credentials, so tests can build it
freely. Startup calls `require_runtime_config()`, which fails loudly when the
chosen backend is incomplete. The fake backend runs only when
`TABULAR_BACKEND=fake` is set explicitly; there is no default backend.
"""

from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from importlib.metadata import version
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from tabular.domain.errors import ConfigurationError

# Central .env file in the repo root (shared across all services).
_ROOT_ENV_FILE = Path(__file__).resolve().parents[4] / ".env"


class AiCoreConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    auth_url: str = Field(min_length=1)
    deployment_url: str = Field(min_length=1)
    client_id: str = Field(min_length=1, repr=False)
    client_secret: str = Field(min_length=1, repr=False)
    resource_group: str = "default"
    max_test_batch: int = Field(default=300, gt=0)
    max_classes: int = Field(default=160, gt=0)
    min_call_interval_seconds: float = Field(default=0.2, ge=0, allow_inf_nan=False)


class PriorLabsConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    api_key: str = Field(min_length=1, repr=False)
    model_path: str = Field(default="v3.5_default", min_length=1)
    max_test_batch: int = Field(default=1_000, gt=0)
    max_classes: int = Field(default=160, gt=0)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ROOT_ENV_FILE, extra="ignore")

    tabular_backend: Literal["fake", "priorlabs", "aicore"] | None = None
    tabular_enabled_backends: list[Literal["fake", "priorlabs", "aicore"]] = Field(
        default_factory=list
    )
    tabular_internal_token: str | None = Field(default=None, repr=False)
    tabular_model_reference_secret: str | None = Field(default=None, repr=False)
    tabular_model_reference_ttl_seconds: int = Field(default=86400, gt=0)

    priorlabs_api_key: str | None = None
    priorlabs_model_path: str = Field(default="v3.5_default", min_length=1)
    priorlabs_max_test_batch: int = Field(default=1_000, gt=0)
    priorlabs_max_classes: int = Field(default=160, gt=0)

    # --- SAP AI Core (only needed when tabular_backend=aicore) ---
    aicore_auth_url: str | None = None
    aicore_api_url: str | None = None
    aicore_client_id: str | None = None
    aicore_client_secret: str | None = None
    aicore_resource_group: str = "default"
    aicore_max_test_batch: int = Field(default=300, gt=0)
    aicore_max_classes: int = Field(default=160, gt=0)
    aicore_min_call_interval_seconds: float = Field(default=0.2, ge=0, allow_inf_nan=False)
    aicore_deployment_id: str | None = None
    # Full deployment URL; if unset it is built from AICORE_API_URL + AICORE_DEPLOYMENT_ID.
    aicore_deployment_url: str | None = None

    # --- Limits ---
    # Training rows per request; CAP samples down to this before sending.
    tabular_max_context_rows: int = Field(default=100_000, gt=0)
    tabular_max_test_rows: int = Field(default=10_000, gt=0)
    # Test rows per backend call; the training context is re-sent per chunk.
    tabular_test_chunk_rows: int = Field(default=1_000, gt=0)
    # Backend calls in flight at once; more requests get 429 + Retry-After.
    tabular_max_concurrent_calls: int = Field(default=4, gt=0)
    tabular_max_columns: int = Field(default=500, gt=0)
    # Cells (rows x columns) over x_train and x_test together.
    tabular_max_cells: int = Field(default=20_000_000, gt=0)
    tabular_max_quantile_levels: int = Field(default=99, gt=0)
    tabular_min_call_budget_seconds: float = Field(default=1.0, ge=0, allow_inf_nan=False)
    tabular_max_execution_cells: int = Field(default=20_000_000, gt=0)
    # Request bodies above this size get 413 before they are parsed.
    tabular_max_body_bytes: int = Field(default=200_000_000, gt=0)
    # Used when the caller sends no X-Deadline-Ms header.
    tabular_default_deadline_seconds: float = Field(default=120.0, gt=0, allow_inf_nan=False)

    host: str = Field(default="127.0.0.1", validation_alias="TABULAR_HOST")
    port: int = Field(default=8080, validation_alias="TABULAR_PORT")

    def require_runtime_config(self) -> AiCoreConfig | PriorLabsConfig | None:
        """Raise `ValueError` naming every missing setting. Called at startup."""
        if self.tabular_backend is None:
            raise ValueError(
                "TABULAR_BACKEND is not set (aicore | priorlabs | fake; "
                "fake returns deterministic dummy predictions)"
            )
        try:
            if self.tabular_backend == "aicore":
                return self.aicore_config()
            if self.tabular_backend == "priorlabs":
                return self.priorlabs_config()
        except ConfigurationError as error:
            raise ValueError(str(error)) from error
        return None

    def aicore_config(self) -> AiCoreConfig:
        required = (
            ("AICORE_AUTH_URL", self.aicore_auth_url),
            ("AICORE_CLIENT_ID", self.aicore_client_id),
            ("AICORE_CLIENT_SECRET", self.aicore_client_secret),
            (
                "AICORE_DEPLOYMENT_URL (or AICORE_API_URL + AICORE_DEPLOYMENT_ID)",
                self.aicore_deployment_url or (self.aicore_api_url and self.aicore_deployment_id),
            ),
        )
        missing = [name for name, value in required if not value]
        if missing:
            raise ConfigurationError(f"AI Core is not configured, missing: {', '.join(missing)}")
        auth_url = (self.aicore_auth_url or "").rstrip("/")
        if not auth_url.endswith("/oauth/token"):
            auth_url += "/oauth/token"
        api_url = (self.aicore_api_url or "").rstrip("/")
        if not api_url.endswith("/v2"):
            api_url += "/v2"
        return AiCoreConfig(
            auth_url=auth_url,
            deployment_url=(
                self.aicore_deployment_url
                or f"{api_url}/inference/deployments/{self.aicore_deployment_id}"
            ).rstrip("/"),
            client_id=self.aicore_client_id or "",
            client_secret=self.aicore_client_secret or "",
            resource_group=self.aicore_resource_group,
            max_test_batch=self.aicore_max_test_batch,
            max_classes=self.aicore_max_classes,
            min_call_interval_seconds=self.aicore_min_call_interval_seconds,
        )

    def backend_cache_identity(self) -> str:
        config = self.require_runtime_config()
        data = {
            "adapter_revision": "tabular-prediction-v3-r1",
            "backend": self.tabular_backend,
            "config": config.model_dump(
                exclude={"api_key", "client_id", "client_secret", "auth_url"}
            )
            if config
            else None,
            "chunk_rows": self.tabular_test_chunk_rows,
            "client_version": version("tabpfn-client")
            if self.tabular_backend == "priorlabs"
            else None,
            "credential_scope": hashlib.sha256(
                (
                    config.api_key
                    if isinstance(config, PriorLabsConfig)
                    else f"{config.client_id}:{config.client_secret}"
                    if isinstance(config, AiCoreConfig)
                    else "synthetic"
                ).encode()
            ).hexdigest(),
        }
        return hashlib.sha256(
            json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()

    def priorlabs_config(self) -> PriorLabsConfig:
        if not self.priorlabs_api_key:
            raise ConfigurationError("Prior Labs is not configured, missing: PRIORLABS_API_KEY")
        return PriorLabsConfig(
            api_key=self.priorlabs_api_key,
            model_path=self.priorlabs_model_path,
            max_test_batch=self.priorlabs_max_test_batch,
            max_classes=self.priorlabs_max_classes,
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
