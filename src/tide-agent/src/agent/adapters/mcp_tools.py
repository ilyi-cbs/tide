"""CAP-backed tool catalog/executor implementing `agent.ports.tools`.

Each caller-scoped turn uses one MCP session; agent-only operations use CAP's
runtime service, with the request correlation ID forwarded to both.
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.types import TextContent

from agent.api.logging import correlation_id
from agent.ports.tools import ToolCallResult, ToolFailure, ToolSpec, json_object


class McpToolClient:
    """Implements both `ToolCatalogPort` and `ToolExecutorPort`."""

    def __init__(
        self,
        url: str,
        *,
        app_id: str = "",
        runtime_url: str = "",
        timeout_seconds: float = 30.0,
    ) -> None:
        self._url = url
        self._app_id = app_id
        self._runtime_url = runtime_url.rstrip("/")
        self._timeout_seconds = timeout_seconds
        self._turn_session: ClientSession | None = None
        self._turn_instructions = ""
        self._turn_authorization: str | None = None
        self._turn_active = False

    @asynccontextmanager
    async def turn(self, *, authorization: str | None) -> AsyncIterator[McpToolClient]:
        if self._turn_active:
            raise RuntimeError("This MCP client already has an active turn.")
        self._turn_active = True
        self._turn_authorization = authorization
        try:
            async with self._open_session(authorization=authorization) as (session, instructions):
                self._turn_session = session
                self._turn_instructions = instructions
                yield self
        finally:
            self._turn_session = None
            self._turn_instructions = ""
            self._turn_authorization = None
            self._turn_active = False

    @asynccontextmanager
    async def _session(
        self, *, authorization: str | None
    ) -> AsyncIterator[tuple[ClientSession, str]]:
        if self._turn_active:
            if authorization != self._turn_authorization:
                raise PermissionError("MCP turn belongs to a different caller.")
            if self._turn_session is None:
                raise RuntimeError("MCP turn session is not ready.")
            yield self._turn_session, self._turn_instructions
        else:
            async with self._open_session(authorization=authorization) as opened:
                yield opened

    def _headers(self, authorization: str | None) -> dict[str, str]:
        headers = {"X-Correlation-Id": correlation_id.get()}
        if authorization:
            headers["Authorization"] = authorization
        return headers

    @asynccontextmanager
    async def _open_session(
        self, *, authorization: str | None
    ) -> AsyncIterator[tuple[ClientSession, str]]:
        async with httpx2.AsyncClient(
            headers=self._headers(authorization), timeout=self._timeout_seconds
        ) as http_client:
            async with streamable_http_client(self._url, http_client=http_client) as (
                read_stream,
                write_stream,
            ):
                async with ClientSession(read_stream, write_stream) as session:
                    initialized = await session.initialize()
                    yield session, initialized.instructions or ""

    async def instructions(self, *, authorization: str | None) -> str:
        async with self._session(authorization=authorization) as (_, instructions):
            return instructions

    async def _runtime(
        self, action: str, body: dict[str, Any], authorization: str | None
    ) -> httpx2.Response:
        async with httpx2.AsyncClient(
            headers=self._headers(authorization), timeout=self._timeout_seconds
        ) as http_client:
            return await http_client.post(f"{self._runtime_url}/{action}", json=body)

    async def profile(self, *, authorization: str | None) -> dict[str, Any]:
        response = await self._runtime("profile", {"app": self._app_id}, authorization)
        response.raise_for_status()
        return json_object(response.json()) or {}

    async def resolve_context(self, context: str, *, authorization: str | None) -> dict[str, Any]:
        response = await self._runtime(
            "resolve_context", {"app": self._app_id, "context": context}, authorization
        )
        response.raise_for_status()
        return json_object(response.json()) or {}

    async def command_result(
        self, tool: str, command_id: str, arguments: str, *, authorization: str | None
    ) -> ToolCallResult:
        response = await self._runtime(
            "command_result",
            {"tool": tool, "commandID": command_id, "arguments": arguments},
            authorization,
        )
        if response.status_code != 200:
            return ToolCallResult(content=response.text, is_error=True)
        return ToolCallResult(content=response.text, is_error=False, data=response.json())

    async def list_tools(self, *, authorization: str | None) -> list[ToolSpec]:
        async with self._session(authorization=authorization) as (session, _):
            result = await session.list_tools()
        return [
            ToolSpec(
                name=tool.name,
                description=tool.description or "",
                input_schema=tool.input_schema,
                read_only=bool(tool.annotations and tool.annotations.read_only_hint),
            )
            for tool in result.tools
        ]

    async def call_tool(
        self, name: str, arguments: dict[str, Any], *, authorization: str | None
    ) -> ToolCallResult:
        async with self._session(authorization=authorization) as (session, _):
            result = await session.call_tool(name, arguments)
        text = "\n".join(block.text for block in result.content if isinstance(block, TextContent))
        structured = json_object(result.structured_content)
        data = (
            structured.get("result")
            if isinstance(structured, dict) and not result.is_error
            else None
        )
        error = _tool_failure(structured, text) if result.is_error else None
        return ToolCallResult(content=text, is_error=bool(result.is_error), data=data, error=error)


def _tool_failure(structured: Any, text: str) -> ToolFailure:
    """Preserve CAP's structured error envelope; use a safe fallback otherwise."""
    envelope = json_object(structured)
    raw = json_object(envelope.get("error")) if envelope is not None else None
    if raw is None:
        return _text_failure(text)
    retry_after = raw.get("retryAfterMs")
    return ToolFailure(
        code=str(raw.get("code") or "MCP_TOOL_ERROR"),
        message=str(raw.get("message") or text or "The tool could not complete."),
        retryable=bool(raw.get("retryable", False)),
        retry_after_ms=retry_after if isinstance(retry_after, int) and retry_after >= 0 else None,
        existing_id=str(raw["existingId"]) if raw.get("existingId") else None,
        reference=str(raw["reference"]) if raw.get("reference") else None,
        reconcile_tool=str(raw["reconcileTool"]) if raw.get("reconcileTool") else None,
        reconcile_arguments=(
            raw.get("reconcileArguments")
            if isinstance(raw.get("reconcileArguments"), dict)
            else None
        ),
    )


def _text_failure(text: str) -> ToolFailure:
    """Normalize CAP MCP's text-only rejected-action fallback.

    `@cap-js/mcp` currently renders rejected actions as text instead of an MCP
    structured error. Cockpit's duplicate prepared-action response contains a
    stable token and action link, which keeps the recovery policy typed.
    """
    match = re.search(r"\[([A-Z_]+)\]", text)
    code = match.group(1) if match else "MCP_TOOL_ERROR"
    action = re.search(r"#/Actions\(([0-9a-f-]+)\)", text, re.IGNORECASE)
    if code == "CONFLICT":
        return ToolFailure(
            code=code,
            message=text or "The tool could not complete.",
            existing_id=action.group(1) if action else None,
            reconcile_tool="list_pending_actions",
            reconcile_arguments={},
        )
    return ToolFailure(code=code, message=text or "The tool could not complete.")
