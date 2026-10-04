"""LangGraph state and the small value objects carried inside it.

`prepare` refreshes per-turn values; credentials remain in request context,
never in checkpointed state.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any, Literal, NotRequired, TypedDict

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages

from agent.ports.tools import ToolSpec


@dataclass(frozen=True)
class PendingToolCall:
    """One LLM-requested tool call awaiting approval or execution."""

    id: str
    name: str
    args: dict[str, Any]


@dataclass(frozen=True)
class ApprovalRequest:
    """One or more write tool calls batched into a single human decision."""

    calls: tuple[PendingToolCall, ...]
    summary: str


@dataclass(frozen=True)
class ExecutionPlan:
    """Validated ordered work requested by one model response."""

    calls: tuple[PendingToolCall, ...]
    current: int = 0

    def next_call(self) -> PendingToolCall | None:
        return self.calls[self.current] if self.current < len(self.calls) else None

    def advance(self) -> ExecutionPlan:
        return ExecutionPlan(calls=self.calls, current=self.current + 1)


@dataclass(frozen=True)
class ExecutionOutcome:
    """A completed plan step retained for deterministic verification."""

    call: PendingToolCall
    success: bool
    data: dict[str, Any] | None = None
    error_code: str | None = None
    status: Literal["completed", "pending", "failed", "unknown"] = "completed"
    retryable: bool = False
    reference: str | None = None


@dataclass
class Budget:
    """Per-turn limits; decremented as the graph runs. Cutoff -> final answer."""

    steps_left: int
    tool_calls_left: int

    def exhausted(self) -> bool:
        return self.steps_left <= 0 or self.tool_calls_left <= 0


class AgentProfile(TypedDict):
    instructions: str
    tools: list[str]
    action_tools: list[str]
    checked: bool
    checks: NotRequired[dict[str, Any]]


class AgentState(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]
    budget: Budget
    tools: list[ToolSpec]
    profile: AgentProfile
    approved_calls: list[PendingToolCall]
    plan: ExecutionPlan | None
    outcomes: list[ExecutionOutcome]
    verification_notes: list[str]


class InputState(TypedDict, total=False):
    """What a caller may send into a turn: messages only.

    Used as the graph's input schema, so client-supplied values for the
    per-turn keys (e.g. an inflated `budget`) are dropped, not merged.
    """

    messages: Annotated[list[AnyMessage], add_messages]
