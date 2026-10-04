"""Builds the request-scoped context dict merged into the graph run.

Kept separate from `api/app.py` so the wiring (which concrete adapters back
each port) is in one obvious place.
"""

from __future__ import annotations

from typing import Any

from agent.adapters.fakes import OfflineChatModel
from agent.adapters.litellm_llm import LiteLLMChatModel
from agent.adapters.mcp_tools import McpToolClient
from agent.config import Settings
from agent.ports.llm import LLMPort
from agent.ports.tools import ToolClientPort
from agent.ports.writes import WriteAttemptPort


def build_llm(settings: Settings) -> LLMPort:
    """Constructs the LLM adapter.

    The fake model is used only when `LLM_FAKE=1` is set explicitly; missing
    credentials are a configuration error, never a silent fallback.
    """
    if settings.llm_fake:
        return OfflineChatModel()
    settings.require_runtime_config()
    assert settings.agent_model is not None
    return LiteLLMChatModel(
        model=settings.agent_model,
        api_key=settings.agent_model_api_key,
        api_base=settings.agent_model_api_base,
        api_version=settings.agent_model_api_version,
        timeout=settings.turn_timeout_s,
    )


def build_tool_client(settings: Settings, app_id: str) -> ToolClientPort:
    """Constructs the tool adapter: always the app's CAP MCP endpoint. Callers are
    verified against CAP anyway, so `LLM_FAKE=1` (offline model) still uses
    the real tools and end-to-end runs see real CAP data."""
    return McpToolClient(
        settings.mcp_url(app_id),
        app_id=app_id,
        runtime_url=settings.runtime_url,
        timeout_seconds=settings.mcp_timeout_seconds,
    )


def build_request_context(
    *,
    authorization: str | None,
    app_id: str = "cockpit",
    settings: Settings,
    llm: LLMPort,
    tools: ToolClientPort,
    page_context: dict[str, Any] | None = None,
    write_attempts: WriteAttemptPort | None = None,
    thread_id: str = "",
    user_id: str = "",
) -> dict[str, Any]:
    """Fields merged into LangGraph's `context` for one turn.

    Plain dict, not `AgentContext` itself: this is exactly what
    `api.agui.TideAgent.get_stream_kwargs` stashes in the request-scoped
    `request_context` ContextVar; LangGraph's `_coerce_context` builds the
    real `AgentContext(**context)` from it inside the graph run.
    """
    return {
        "llm": llm,
        "tool_catalog": tools,
        "tool_executor": tools,
        "write_attempts": write_attempts,
        "thread_id": thread_id,
        "user_id": user_id,
        "authorization": authorization,
        "page_context": page_context,
        "app_id": app_id,
        "max_steps": settings.max_steps,
        "max_tool_calls": settings.max_tool_calls,
        "max_history_tokens": settings.max_history_tokens,
        "max_tool_result_chars": settings.max_tool_result_chars,
        "max_prompt_tokens": settings.max_prompt_tokens,
        "max_output_tokens": settings.max_output_tokens,
    }
