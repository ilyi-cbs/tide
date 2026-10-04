from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from agent.graph.state import PendingToolCall
from agent.ports.tools import ToolCallResult


@dataclass(frozen=True)
class WriteAttempt:
    call: PendingToolCall
    result: ToolCallResult | None


@runtime_checkable
class WriteAttemptPort(Protocol):
    async def begin(
        self, thread_id: str, user_id: str, app_id: str, call: PendingToolCall
    ) -> bool: ...

    async def finish(
        self,
        thread_id: str,
        user_id: str,
        app_id: str,
        call: PendingToolCall,
        result: ToolCallResult,
    ) -> None: ...

    async def list_attempts(
        self, thread_id: str, user_id: str, app_id: str | None
    ) -> list[WriteAttempt]: ...
