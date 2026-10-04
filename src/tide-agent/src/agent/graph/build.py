"""Assembles the graph:

    prepare -> llm -> approve -> tools -> llm ... -> check -> END
                 \\-> finalize -> check -> END    (budget exhausted)

`InputState` is the input schema, so a turn accepts only messages from the
caller; the per-turn keys are always set by `prepare`.
"""

from __future__ import annotations

from typing import Any, cast

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from agent.graph.context import AgentContext
from agent.graph.nodes import (
    call_llm,
    check,
    finalize,
    plan,
    prepare,
    request_approval,
    route_after_execute,
    route_after_llm,
    route_after_plan,
    route_after_verify,
    run_tools,
    verify,
)
from agent.graph.state import AgentState, InputState


def build_graph(
    checkpointer: BaseCheckpointSaver[Any] | None = None,
) -> CompiledStateGraph[AgentState, AgentContext, InputState, AgentState]:
    builder: Any = StateGraph(AgentState, context_schema=AgentContext, input_schema=InputState)
    builder.add_node("prepare", prepare)
    builder.add_node("llm", call_llm)
    builder.add_node("plan", plan)
    builder.add_node("request_approval", request_approval)
    builder.add_node("tools", run_tools)
    builder.add_node("verify", verify)
    builder.add_node("finalize", finalize)
    builder.add_node("check", check)

    builder.add_edge(START, "prepare")
    builder.add_edge("prepare", "llm")
    builder.add_conditional_edges(
        "llm", route_after_llm, {"plan": "plan", "finalize": "finalize", "end": "check"}
    )
    builder.add_conditional_edges(
        "plan",
        route_after_plan,
        {
            "tools": "tools",
            "request_approval": "request_approval",
            "llm": "llm",
            "finalize": "finalize",
        },
    )
    builder.add_edge("request_approval", "tools")
    builder.add_conditional_edges(
        "tools",
        route_after_execute,
        {"verify": "verify", "llm": "llm", "finalize": "finalize"},
    )
    builder.add_conditional_edges(
        "verify", route_after_verify, {"plan": "plan", "llm": "llm", "finalize": "finalize"}
    )
    builder.add_edge("finalize", "check")
    builder.add_edge("check", END)

    return cast(
        CompiledStateGraph[AgentState, AgentContext, InputState, AgentState],
        builder.compile(checkpointer=checkpointer),
    )
