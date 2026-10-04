from __future__ import annotations

import pytest

from agent.ports.tools import ToolSpec


@pytest.fixture
def read_only_tool() -> ToolSpec:
    return ToolSpec(name="list_feeds", description="Lists feeds", input_schema={}, read_only=True)


@pytest.fixture
def write_tool() -> ToolSpec:
    return ToolSpec(
        name="start_prediction", description="Starts a prediction", input_schema={}, read_only=False
    )


_SETTINGS_ENV = (
    "LLM_FAKE",
    "AGENT_MODEL",
    "AGENT_MODEL_API_KEY",
    "AGENT_MODEL_API_BASE",
    "AGENT_MODEL_API_VERSION",
    "CAP_URL",
    "CHECKPOINT_DB",
    "CORS_ORIGINS",
    "AUTH_CACHE_SECONDS",
    "MAX_STEPS",
    "MAX_TOOL_CALLS",
    "MAX_PARALLEL_TOOL_CALLS",
    "MAX_HISTORY_TOKENS",
    "MAX_TOOL_RESULT_CHARS",
)


@pytest.fixture(autouse=True)
def _isolated_settings_env(monkeypatch):
    """Tests must not depend on the developer's shell or .env."""
    for name in _SETTINGS_ENV:
        monkeypatch.delenv(name, raising=False)
