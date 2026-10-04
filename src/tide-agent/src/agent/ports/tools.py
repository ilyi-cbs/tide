"""Ports for the MCP tool catalog and tool execution.

Kept separate from the LLM port (hexagonal architecture): the graph depends
only on these Protocols, never on the `mcp` client library directly, so tests
swap in a stub without patching anything.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, cast, runtime_checkable


@dataclass(frozen=True)
class ToolSpec:
    """One MCP tool, as needed by the graph (LLM schema + approval policy)."""

    name: str
    description: str
    input_schema: dict[str, Any]
    read_only: bool


@dataclass(frozen=True)
class ToolCallResult:
    """Normalized result of one tool call.

    `data` is the structured result (MCP `structuredContent.result`) when the
    server sent one; `content` is its text form.
    """

    content: str
    is_error: bool
    data: Any = None
    error: ToolFailure | None = None


@dataclass(frozen=True)
class ToolFailure:
    """Machine-readable MCP failure retained alongside the safe display text."""

    code: str
    message: str
    retryable: bool = False
    retry_after_ms: int | None = None
    existing_id: str | None = None
    reference: str | None = None
    reconcile_tool: str | None = None
    reconcile_arguments: dict[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "retryAfterMs": self.retry_after_ms,
            "existingId": self.existing_id,
            "reference": self.reference,
            "reconcileTool": self.reconcile_tool,
            "reconcileArguments": self.reconcile_arguments,
        }


@runtime_checkable
class ToolCatalogPort(Protocol):
    """One chat app's CAP surface, scoped to the caller's identity.

    The MCP endpoint of the app supplies the tools and the model instructions;
    CAP's runtime service supplies what the agent alone needs (profile, page context).
    """

    async def list_tools(self, *, authorization: str | None) -> list[ToolSpec]: ...

    async def instructions(self, *, authorization: str | None) -> str: ...

    async def profile(self, *, authorization: str | None) -> dict[str, Any]: ...

    async def resolve_context(
        self, context: str, *, authorization: str | None
    ) -> dict[str, Any]: ...


@runtime_checkable
class ToolExecutorPort(Protocol):
    """Calls one MCP tool, scoped to the caller's identity."""

    async def call_tool(
        self, name: str, arguments: dict[str, Any], *, authorization: str | None
    ) -> ToolCallResult: ...

    async def command_result(
        self, tool: str, command_id: str, arguments: str, *, authorization: str | None
    ) -> ToolCallResult: ...


@runtime_checkable
class ToolClientPort(ToolCatalogPort, ToolExecutorPort, Protocol):
    pass


def json_object(value: object) -> dict[str, Any] | None:
    return cast(dict[str, Any], value) if isinstance(value, dict) else None


def json_array(value: object) -> list[Any] | None:
    return cast(list[Any], value) if isinstance(value, list) else None
