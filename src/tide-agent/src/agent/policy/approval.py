"""ApprovalPolicy: decide which LLM tool calls need a human decision first.

`readOnlyHint` (from `@cap-js/mcp`, derived from
`kind==='function'`) is authoritative — functions are read-only, actions are
destructive. The execution plan asks for consent for one write step at a time.
"""

from __future__ import annotations

from dataclasses import dataclass

from agent.graph.state import ApprovalRequest, PendingToolCall
from agent.ports.tools import ToolSpec


@dataclass(frozen=True)
class ApprovalPolicy:
    tools_by_name: dict[str, ToolSpec]

    def split(
        self, calls: list[PendingToolCall]
    ) -> tuple[list[PendingToolCall], list[PendingToolCall]]:
        """Returns (read_only_calls, write_calls)."""
        read_only: list[PendingToolCall] = []
        writes: list[PendingToolCall] = []
        for call in calls:
            spec = self.tools_by_name.get(call.name)
            # Unknown tool (not in the current catalog): treat as a write, so
            # it is never executed without a human decision.
            if spec is not None and spec.read_only:
                read_only.append(call)
            else:
                writes.append(call)
        return read_only, writes

    def summarize(self, writes: list[PendingToolCall]) -> ApprovalRequest:
        lines: list[str] = []
        for call in writes:
            spec = self.tools_by_name.get(call.name)
            description = spec.description if spec else "(unknown tool)"
            lines.append(f"- {call.name}({call.args}): {description}")
        summary = "The assistant wants to perform:\n" + "\n".join(lines)
        return ApprovalRequest(calls=tuple(writes), summary=summary)
