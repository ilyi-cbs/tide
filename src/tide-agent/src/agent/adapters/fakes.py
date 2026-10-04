"""Deterministic, offline fakes for `LLM_FAKE=1` / tests."""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator, Callable, Iterator, Sequence
from typing import Any
from uuid import uuid4

from langchain_core.callbacks import (
    AsyncCallbackManagerForLLMRun,
    CallbackManagerForLLMRun,
)
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.runnables import Runnable
from langchain_core.tools import BaseTool

from agent.ports.identity import Caller, Unauthenticated
from agent.ports.tools import ToolCallResult, ToolSpec, json_array, json_object


class ScriptedFakeChatModel(BaseChatModel):
    """Replays a fixed sequence of `AIMessage`s, one per invocation.

    `bind_tools` is a no-op (returns self) since the script already encodes
    which tool calls to emit; it exists only so the graph can call
    `llm.bind_tools(...)` uniformly for both the real and fake models.
    """

    responses: list[AIMessage]
    _index: int = 0

    @property
    def _llm_type(self) -> str:
        return "scripted-fake"

    def bind_tools(
        self,
        tools: Sequence[dict[str, Any] | type[Any] | Callable[..., Any] | BaseTool],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable[Any, AIMessage]:
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        message = self.responses[self._index]
        self._index = min(self._index + 1, len(self.responses) - 1)
        return ChatResult(generations=[ChatGeneration(message=message)])

    async def _astream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        message = self.responses[self._index]
        self._index = min(self._index + 1, len(self.responses) - 1)
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content=message.content,
                tool_calls=message.tool_calls,
            )
        )


class FakeToolClient:
    """In-memory `ToolCatalogPort` and `ToolExecutorPort` for tests."""

    def __init__(
        self,
        tools: list[ToolSpec],
        results: dict[str, ToolCallResult] | None = None,
        *,
        instructions: str = "rules",
        profile: dict[str, Any] | Exception | None = None,
        context: dict[str, Any] | Exception | None = None,
        receipt: ToolCallResult | Exception | None = None,
    ) -> None:
        self._tools = tools
        self._results = results or {}
        self._instructions = instructions
        self._profile = profile if profile is not None else {"checked": False}
        self._context = context if context is not None else {"valid": False}
        self._receipt = receipt or ToolCallResult(content="not found", is_error=True)
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def list_tools(self, *, authorization: str | None) -> list[ToolSpec]:
        return list(self._tools)

    async def instructions(self, *, authorization: str | None) -> str:
        return self._instructions

    async def profile(self, *, authorization: str | None) -> dict[str, Any]:
        self.calls.append(("profile", {}))
        if isinstance(self._profile, Exception):
            raise self._profile
        return self._profile

    async def resolve_context(self, context: str, *, authorization: str | None) -> dict[str, Any]:
        self.calls.append(("resolve_context", {"context": context}))
        if isinstance(self._context, Exception):
            raise self._context
        return self._context

    async def command_result(
        self, tool: str, command_id: str, arguments: str, *, authorization: str | None
    ) -> ToolCallResult:
        self.calls.append(
            ("command_result", {"tool": tool, "commandID": command_id, "arguments": arguments})
        )
        if isinstance(self._receipt, Exception):
            raise self._receipt
        return self._receipt

    async def call_tool(
        self, name: str, arguments: dict[str, Any], *, authorization: str | None
    ) -> ToolCallResult:
        self.calls.append((name, arguments))
        return self._results.get(name, ToolCallResult(content="{}", is_error=False))


class FakeIdentity:
    """In-memory `IdentityPort`: maps known Authorization headers to user IDs."""

    def __init__(self, users: dict[str, str]) -> None:
        self._users = users

    async def verify(self, authorization: str | None) -> Caller:
        if not authorization:
            raise Unauthenticated("missing Authorization header")
        user_id = self._users.get(authorization)
        if user_id is None:
            raise Unauthenticated("unknown credentials")
        return Caller(user_id=user_id, authorization=authorization)


OFFLINE_TEXT = "(Using the local offline model.)"
# Read-only tools the offline model calls on its own, first match wins.
OFFLINE_DEMO_TOOLS = ("list_priorities",)
OFFLINE_MAX_LINKS = 10


def _linked_rows(value: Any) -> Iterator[dict[str, Any]]:
    """Yields every JSON object (depth first) that carries an in-app `link`."""
    sequence = json_array(value)
    mapping = json_object(value)
    if sequence is not None:
        for item in sequence:
            yield from _linked_rows(item)
    elif mapping is not None:
        link = mapping.get("link")
        if isinstance(link, str) and link.startswith("#/"):
            yield mapping
        for key, item in mapping.items():
            if key != "link":
                yield from _linked_rows(item)


def _link_label(row: dict[str, Any]) -> str:
    """Short human label for a linked row, from the cockpit's key fields."""
    if row.get("PurchaseOrder"):
        label = f"PO {row['PurchaseOrder']}"
        if row.get("PurchaseOrderItem"):
            label += f"/{row['PurchaseOrderItem']}"
    elif row.get("Material") or row.get("Supplier"):
        parts = [
            f"{name} {row[key]}"
            for key, name in (
                ("Material", "Material"),
                ("Supplier", "Supplier"),
                ("Plant", "Plant"),
            )
            if row.get(key)
        ]
        label = " · ".join(parts)
    elif row.get("Customer"):
        label = str(row.get("CustomerName") or row.get("customerName") or row["Customer"])
    else:
        label = str(row.get("title") or row.get("name") or row.get("ID") or "Open")
    return label.replace("[", "(").replace("]", ")")


# TOON tabular array header, e.g. `result[10]{priority,PurchaseOrder,link}:`
# (optional `|` or tab delimiter marker inside the brackets).
_TOON_HEADER = re.compile(r"^(\s*)[\w.-]*\[#?\d+([|\t]?)\]\{(.+)\}:\s*$")


def _toon_values(line: str, delimiter: str) -> list[str]:
    """Splits one TOON row; double-quoted cells use backslash escapes."""
    values: list[str] = []
    cell: list[str] = []
    quoted = escaped = False
    for char in line:
        if escaped:
            cell.append({"n": "\n", "t": "\t", "r": "\r"}.get(char, char))
            escaped = False
        elif quoted and char == "\\":
            escaped = True
        elif char == '"':
            quoted = not quoted
        elif char == delimiter and not quoted:
            values.append("".join(cell).strip())
            cell = []
        else:
            cell.append(char)
    values.append("".join(cell).strip())
    return values


def _toon_rows(text: str) -> list[dict[str, Any]]:
    """Rows of every tabular array in a TOON document (what CAP's MCP returns)."""
    rows: list[dict[str, Any]] = []
    lines = text.splitlines()
    for index, line in enumerate(lines):
        header = _TOON_HEADER.match(line)
        if not header:
            continue
        indent, delimiter = len(header.group(1)), header.group(2) or ","
        fields = _toon_values(header.group(3), delimiter)
        for row in lines[index + 1 :]:
            if not row.strip() or len(row) - len(row.lstrip()) <= indent:
                break
            values = _toon_values(row.strip(), delimiter)
            if len(values) == len(fields):
                rows.append(dict(zip(fields, values, strict=True)))
    return rows


def offline_answer(content: str) -> str:
    """Final answer for a tool result: a markdown link list, else the raw text.

    Accepts JSON and TOON (tabular arrays) tool results.
    """
    try:
        data = json.loads(content)
    except (TypeError, ValueError):
        data = _toon_rows(content)
    rows = list(_linked_rows(data))
    if not rows:
        return f"{OFFLINE_TEXT} Tool result:\n\n{content}"
    lines: list[str] = []
    for row in rows[:OFFLINE_MAX_LINKS]:
        line = f"- [{_link_label(row)}]({row['link']})"
        detail = row.get("status") or row.get("reason")
        if isinstance(detail, str) and detail:
            line += f" — {detail}"
        lines.append(line)
    if len(rows) > OFFLINE_MAX_LINKS:
        lines.append(f"- … and {len(rows) - OFFLINE_MAX_LINKS} more")
    return f"{OFFLINE_TEXT} Found {len(rows)}:\n\n" + "\n".join(lines)


class OfflineChatModel(BaseChatModel):
    """Fixed greeting/help replies; otherwise answers only from CAP tool results."""

    tool_names: list[str] = []

    @property
    def _llm_type(self) -> str:
        return "offline-fake"

    def bind_tools(
        self,
        tools: Sequence[dict[str, Any] | type[Any] | Callable[..., Any] | BaseTool],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable[Any, AIMessage]:
        names = [
            entry["function"]["name"]
            for tool in tools
            if (entry := json_object(tool)) is not None and "function" in entry
        ]
        return self.model_copy(update={"tool_names": names})

    def _reply(self, messages: list[BaseMessage]) -> AIMessage:
        last = messages[-1] if messages else None
        if isinstance(last, ToolMessage):
            return AIMessage(content=offline_answer(str(last.content)))
        if any(
            isinstance(message, SystemMessage)
            and "could not be loaded right now" in str(message.content)
            for message in messages
        ):
            return AIMessage(
                content=("TIDE cannot look anything up at the moment. Please try again later.")
            )
        demo = next((name for name in OFFLINE_DEMO_TOOLS if name in self.tool_names), None)
        if isinstance(last, HumanMessage) and demo:
            return AIMessage(
                content="",
                tool_calls=[{"name": demo, "args": {}, "id": f"offline-{uuid4().hex[:12]}"}],
            )
        greeting = next(
            (
                str(message.content)
                for message in messages
                if isinstance(message, SystemMessage)
                and "TIDE, your purchasing desk" in str(message.content)
            ),
            None,
        )
        if isinstance(last, HumanMessage) and greeting:
            request = str(last.content).strip().lower().rstrip(".!?")
            if request in {"hi", "hello", "hey", "good morning", "good afternoon"}:
                return AIMessage(
                    content="Hey! What would you like to check in TIDE, your purchasing desk?"
                )
            if request in {
                "what can you do",
                "what do you do",
                "how can you help",
                "what can i ask",
            }:
                return AIMessage(
                    content=(
                        "I can check delivery risks, open orders, prices, planned delivery "
                        "times, requisitions, and pending actions. I can also run supported "
                        "predictions and prepare actions for your decision."
                    )
                )
        return AIMessage(content=OFFLINE_TEXT)

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=self._reply(messages))])

    async def _astream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        message = self._reply(messages)
        yield ChatGenerationChunk(
            message=AIMessageChunk(content=message.content, tool_calls=message.tool_calls)
        )
