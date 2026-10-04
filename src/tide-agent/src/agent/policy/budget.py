"""Budget policy: bounds a runaway tool-call loop / cost per turn."""

from __future__ import annotations

from agent.graph.state import Budget


def new_budget(*, max_steps: int, max_tool_calls: int) -> Budget:
    return Budget(steps_left=max_steps, tool_calls_left=max_tool_calls)


def charge(budget: Budget, *, steps: int = 0, tool_calls: int = 0) -> Budget:
    """Returns a new Budget with the given usage deducted (never below zero)."""
    return Budget(
        steps_left=max(0, budget.steps_left - steps),
        tool_calls_left=max(0, budget.tool_calls_left - tool_calls),
    )


def affordable(budget: Budget, requested: int) -> int:
    """How many of `requested` tool calls the remaining budget allows."""
    return max(0, min(requested, budget.tool_calls_left))
