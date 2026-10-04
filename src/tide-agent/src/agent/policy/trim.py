"""History trimming: keep the conversation within a token budget.

`trim_history` decides which of the oldest messages to drop so the rest fits
`max_tokens` (approximate count). It only cuts in front of a `HumanMessage`,
so a kept AI tool call always keeps its tool results and every kept tool
result keeps its call. The newest user message is always kept, even if it
alone exceeds the budget.

The graph applies the result as `RemoveMessage`s, so the stored thread
shrinks too; without that, the `add_messages` reducer would keep appending.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

from langchain_core.messages import (
    AnyMessage,
    HumanMessage,
    ToolMessage,
    convert_to_openai_messages,
)
from langchain_core.messages.utils import count_tokens_approximately

from agent.ports.tools import json_object


def trim_history(messages: Sequence[AnyMessage], *, max_tokens: int) -> list[AnyMessage]:
    """The messages to drop, oldest first. Empty if everything fits."""
    if count_tokens_approximately(list(messages)) <= max_tokens:
        return []
    starts = [i for i, m in enumerate(messages) if isinstance(m, HumanMessage)]
    for start in starts:
        if count_tokens_approximately(list(messages[start:])) <= max_tokens:
            return list(messages[:start])
    # Even the newest exchange alone is over budget: keep just that one.
    return list(messages[: starts[-1]]) if starts else []


def prompt_cost(messages: Sequence[AnyMessage], tools: list[dict[str, Any]]) -> int:
    payload = {"messages": convert_to_openai_messages(list(messages)), "tools": tools}
    return len(json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")) + 32 * len(
        messages
    )


def fit_prompt(
    messages: list[AnyMessage], tools: list[dict[str, Any]], max_tokens: int
) -> list[AnyMessage] | None:
    fitted = list(messages)
    while prompt_cost(fitted, tools) > max_tokens:
        starts = [
            index for index, message in enumerate(fitted) if isinstance(message, HumanMessage)
        ]
        if len(starts) < 2:
            break
        del fitted[starts[0] : starts[1]]
    if prompt_cost(fitted, tools) <= max_tokens:
        return fitted
    for index, message in enumerate(fitted):
        if not isinstance(message, ToolMessage) or len(str(message.content)) <= 256:
            continue
        metadata: dict[str, Any] = {}
        try:
            data = json_object(json.loads(str(message.content)))
        except ValueError:
            data = None
        if data is not None:
            metadata = {
                key: data[key]
                for key in (
                    "ID",
                    "status",
                    "caseID",
                    "actionID",
                    "submissionID",
                    "commandID",
                    "error",
                )
                if key in data and len(str(data[key])) <= 256
            }
        content = (
            json.dumps(metadata, ensure_ascii=False)
            + "\n[Result body omitted to fit the prompt budget.]"
        )
        fitted[index] = message.model_copy(update={"content": content})
        if prompt_cost(fitted, tools) <= max_tokens:
            return fitted
    return None
