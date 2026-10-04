"""Per-invocation context: ports + request-scoped auth.
Per-invocation ports and request data stay outside checkpointed graph state.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import ConfigDict
from pydantic.json_schema import SkipJsonSchema

from agent.ports.llm import LLMPort
from agent.ports.tools import ToolCatalogPort, ToolExecutorPort
from agent.ports.writes import WriteAttemptPort


@dataclass(frozen=True, init=False)
class AgentContext:
    """LangGraph context constructed via `_coerce_context`.

    The initializer discards library-injected keys such as `thread_id`;
    `SkipJsonSchema` and `arbitrary_types_allowed` support per-run schema generation.
    """

    __pydantic_config__ = ConfigDict(arbitrary_types_allowed=True)

    llm: SkipJsonSchema[LLMPort]
    tool_catalog: SkipJsonSchema[ToolCatalogPort]
    tool_executor: SkipJsonSchema[ToolExecutorPort]
    write_attempts: SkipJsonSchema[WriteAttemptPort | None]
    thread_id: str
    user_id: str
    authorization: str | None
    page_context: dict[str, object] | None
    page_context_resolution: dict[str, Any]
    app_id: str = "cockpit"
    max_steps: int
    max_tool_calls: int
    max_history_tokens: int = 60_000
    max_tool_result_chars: int = 20_000
    max_prompt_tokens: int = 121_856
    max_output_tokens: int = 4096

    def __init__(
        self,
        *,
        llm: LLMPort,
        tool_catalog: ToolCatalogPort,
        tool_executor: ToolExecutorPort,
        authorization: str | None,
        write_attempts: WriteAttemptPort | None = None,
        thread_id: str = "",
        user_id: str = "",
        page_context: dict[str, object] | None = None,
        page_context_resolution: dict[str, Any] | None = None,
        max_steps: int,
        max_tool_calls: int,
        app_id: str = "cockpit",
        max_history_tokens: int = 60_000,
        max_tool_result_chars: int = 20_000,
        max_prompt_tokens: int = 121_856,
        max_output_tokens: int = 4096,
        **_ignored: object,
    ) -> None:
        object.__setattr__(self, "llm", llm)
        object.__setattr__(self, "tool_catalog", tool_catalog)
        object.__setattr__(self, "tool_executor", tool_executor)
        object.__setattr__(self, "write_attempts", write_attempts)
        object.__setattr__(self, "thread_id", thread_id)
        object.__setattr__(self, "user_id", user_id)
        object.__setattr__(self, "authorization", authorization)
        object.__setattr__(self, "page_context", page_context)
        object.__setattr__(
            self,
            "page_context_resolution",
            page_context_resolution if page_context_resolution is not None else {},
        )
        object.__setattr__(self, "app_id", app_id)
        object.__setattr__(self, "max_steps", max_steps)
        object.__setattr__(self, "max_tool_calls", max_tool_calls)
        object.__setattr__(self, "max_history_tokens", max_history_tokens)
        object.__setattr__(self, "max_tool_result_chars", max_tool_result_chars)
        object.__setattr__(self, "max_prompt_tokens", max_prompt_tokens)
        object.__setattr__(self, "max_output_tokens", max_output_tokens)
