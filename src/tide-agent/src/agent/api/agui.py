"""AG-UI transport adapter: request-scoped context and tool results on the stream.

Secrets travel through runtime context, not checkpointed `config`; node-returned
`ToolMessage`s are emitted as `TOOL_CALL_RESULT` events.
"""

from __future__ import annotations

import contextvars
from collections.abc import AsyncGenerator
from typing import Any, Literal, cast

from ag_ui.core import EventType, ToolCallResultEvent
from ag_ui_langgraph import LangGraphAgent
from ag_ui_langgraph.utils import normalize_tool_content
from langchain_core.messages import ToolMessage
from langchain_core.runnables import RunnableConfig

from agent.ports.tools import json_array, json_object

request_context: contextvars.ContextVar[dict[str, Any]] = contextvars.ContextVar(
    "agent_request_context"
)


class TideAgent(LangGraphAgent):
    """Stream node-returned `ToolMessage`s with status and artifact fields."""

    async def _handle_single_event(self, event: Any, state: Any) -> AsyncGenerator[Any, None]:
        async for raw in super()._handle_single_event(event, state):
            processed: Any = raw
            if processed is not None and processed.type == EventType.TOOL_CALL_RESULT:
                self._results_sent().add(processed.tool_call_id)
            yield processed
        for message in _node_tool_messages(event):
            call_id = self._resolve_public_tool_call_id(message.tool_call_id)
            if call_id in self._results_sent():
                continue
            self._results_sent().add(call_id)
            result = ToolCallResultEvent.model_validate(
                {
                    "type": EventType.TOOL_CALL_RESULT,
                    "tool_call_id": call_id,
                    "message_id": self._resolve_public_message_id(
                        str(message.id or message.tool_call_id)
                    ),
                    "content": normalize_tool_content(message.content),
                    "role": "tool",
                    # Extra fields (the event model allows them): the client
                    # shows failed calls as failed and renders result cards.
                    "status": message.status,
                    **({"artifact": message.artifact} if message.artifact else {}),
                }
            )
            dispatch: Any = self._dispatch_event
            yield dispatch(result)

    def _results_sent(self) -> set[str]:
        # `active_run` is fresh per run, so the set is too.
        assert self.active_run is not None
        run = cast(dict[str, Any], self.active_run)
        return cast(set[str], run.setdefault("tide_tool_results_sent", set[str]()))

    def get_stream_kwargs(
        self,
        input: Any,
        subgraphs: bool = False,
        version: Literal["v1", "v2"] = "v2",
        config: RunnableConfig | None = None,
        context: dict[str, Any] | None = None,
        fork: Any | None = None,
    ) -> dict[str, Any]:
        merged = {**(context or {}), **request_context.get({})}
        return super().get_stream_kwargs(
            input=input,
            subgraphs=subgraphs,
            version=version,
            config=config,
            context=merged,
            fork=fork,
        )


def _node_tool_messages(event: dict[str, Any]) -> list[ToolMessage]:
    """The `ToolMessage`s a graph node returned, from its `on_chain_end` event."""
    if event.get("event") != "on_chain_end":
        return []
    node = (json_object(event.get("metadata")) or {}).get("langgraph_node")
    if node is None or event.get("name") != node:
        return []  # the graph itself, or a router/runnable inside a node
    output = json_object((json_object(event.get("data")) or {}).get("output"))
    messages: list[Any] = json_array(output.get("messages")) or [] if output else []
    return [m for m in messages or [] if isinstance(m, ToolMessage)]
