"""Verifies McpToolClient's parsing of `mcp` responses into ToolSpec/ToolCallResult.

Uses CAP's MCP tool shape (readOnlyHint on
functions, none on actions) to guard against field-name drift between the
`mcp` SDK and this adapter -- a plain unit test, not a live CAP call.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from mcp.types import CallToolResult, ListToolsResult, TextContent, Tool, ToolAnnotations

from agent.adapters import mcp_tools as mcp_tools_module
from agent.adapters.mcp_tools import McpToolClient


class _FakeSession:
    def __init__(self, list_result: ListToolsResult, call_result: CallToolResult) -> None:
        self._list_result = list_result
        self._call_result = call_result
        self.initialized = False
        self.initializations = 0
        self.catalog_reads = 0

    async def initialize(self) -> SimpleNamespace:
        self.initialized = True
        self.initializations += 1
        return SimpleNamespace(instructions="App instructions")

    async def list_tools(self) -> ListToolsResult:
        self.catalog_reads += 1
        return self._list_result

    async def call_tool(self, name: str, arguments: dict) -> CallToolResult:
        return self._call_result


def _patch_session(monkeypatch, session: _FakeSession, captured_headers: dict) -> None:
    @asynccontextmanager
    async def fake_streamable_http_client(url, *, http_client=None):
        captured_headers["auth"] = http_client.headers.get("Authorization") if http_client else None
        yield (object(), object())

    @asynccontextmanager
    async def fake_client_session(read_stream, write_stream):
        try:
            yield session
        finally:
            captured_headers["closed"] = captured_headers.get("closed", 0) + 1

    monkeypatch.setattr(mcp_tools_module, "streamable_http_client", fake_streamable_http_client)
    monkeypatch.setattr(mcp_tools_module, "ClientSession", fake_client_session)


async def test_list_tools_maps_read_only_hint(monkeypatch):
    list_result = ListToolsResult(
        tools=[
            Tool(
                name="list_feeds",
                description="Lists feeds",
                inputSchema={"type": "object"},
                annotations=ToolAnnotations(readOnlyHint=True),
            ),
            Tool(
                name="start_prediction",
                description="Starts a prediction",
                inputSchema={"type": "object"},
                annotations=ToolAnnotations(readOnlyHint=False),
            ),
        ]
    )
    session = _FakeSession(list_result, CallToolResult(content=[]))
    captured: dict = {}
    _patch_session(monkeypatch, session, captured)

    client = McpToolClient("http://cap.local/mcp/cockpit")
    tools = await client.list_tools(authorization="Bearer test-token")

    by_name = {t.name: t for t in tools}
    assert by_name["list_feeds"].read_only is True
    assert by_name["start_prediction"].read_only is False
    assert captured["auth"] == "Bearer test-token"


async def test_call_tool_concatenates_text_blocks_and_error_flag(monkeypatch):
    call_result = CallToolResult(
        content=[TextContent(type="text", text="line1"), TextContent(type="text", text="line2")],
        isError=True,
    )
    session = _FakeSession(ListToolsResult(tools=[]), call_result)
    _patch_session(monkeypatch, session, {})

    client = McpToolClient("http://cap.local/mcp/cockpit")
    result = await client.call_tool("start_prediction", {}, authorization=None)

    assert result.content == "line1\nline2"
    assert result.is_error is True


async def test_call_tool_preserves_structured_failure(monkeypatch):
    call_result = CallToolResult(
        content=[TextContent(type="text", text="already prepared")],
        isError=True,
        structuredContent={
            "error": {
                "code": "CONFLICT",
                "message": "already prepared",
                "retryable": False,
                "existingId": "a1",
                "reference": "corr-1",
                "reconcileTool": "list_pending_actions",
                "reconcileArguments": {},
            }
        },
    )
    session = _FakeSession(ListToolsResult(tools=[]), call_result)
    _patch_session(monkeypatch, session, {})

    result = await McpToolClient("http://cap.local/mcp/cockpit").call_tool(
        "prepare_case_action", {}, authorization=None
    )

    assert result.error is not None
    assert result.error.code == "CONFLICT"
    assert result.error.existing_id == "a1"
    assert result.error.reconcile_tool == "list_pending_actions"


async def test_call_tool_normalizes_cap_text_conflict(monkeypatch):
    call_result = CallToolResult(
        content=[
            TextContent(
                type="text",
                text="Error calling prepare_case_action: [CONFLICT] draft exists: #/Actions(a1)",
            )
        ],
        isError=True,
    )
    session = _FakeSession(ListToolsResult(tools=[]), call_result)
    _patch_session(monkeypatch, session, {})

    result = await McpToolClient("http://cap.local/mcp/cockpit").call_tool(
        "prepare_case_action", {}, authorization=None
    )

    assert result.error is not None
    assert result.error.code == "CONFLICT"
    assert result.error.existing_id == "a1"
    assert result.error.reconcile_tool == "list_pending_actions"


async def test_turn_reuses_session_without_caching_catalog(monkeypatch):
    session = _FakeSession(ListToolsResult(tools=[]), CallToolResult(content=[]))
    captured = {}
    _patch_session(monkeypatch, session, captured)
    client = McpToolClient("http://cap.local/mcp/cockpit")
    async with client.turn(authorization="Bearer alice"):
        await client.list_tools(authorization="Bearer alice")
        await client.call_tool("lookup", {}, authorization="Bearer alice")
        await client.list_tools(authorization="Bearer alice")
        assert session.initializations == 1
        assert session.catalog_reads == 2
    assert captured["closed"] == 1
    await client.list_tools(authorization="Bearer alice")
    assert session.initializations == 2


async def test_instructions_returns_initialize_instructions_inside_turn(monkeypatch):
    session = _FakeSession(ListToolsResult(tools=[]), CallToolResult(content=[]))
    captured = {}
    _patch_session(monkeypatch, session, captured)
    client = McpToolClient("http://cap.local/mcp/cockpit")
    async with client.turn(authorization="Bearer alice"):
        assert await client.instructions(authorization="Bearer alice") == "App instructions"
        assert await client.instructions(authorization="Bearer alice") == "App instructions"
        assert session.initializations == 1
    assert captured["closed"] == 1


async def test_turn_rejects_other_caller_and_nested_scope(monkeypatch):
    session = _FakeSession(ListToolsResult(tools=[]), CallToolResult(content=[]))
    captured = {}
    _patch_session(monkeypatch, session, captured)
    client = McpToolClient("http://cap.local/mcp/cockpit")
    async with client.turn(authorization="Bearer alice"):
        with pytest.raises(PermissionError):
            await client.call_tool("lookup", {}, authorization="Bearer bob")
        with pytest.raises(RuntimeError):
            async with client.turn(authorization="Bearer alice"):
                pass
        assert captured["auth"] == "Bearer alice"
    async with client.turn(authorization="Bearer bob"):
        assert captured["auth"] == "Bearer bob"
        assert session.initializations == 2


@pytest.mark.parametrize("failure", [asyncio.CancelledError, RuntimeError])
async def test_turn_cleans_up_after_cancellation_or_failure(monkeypatch, failure):
    session = _FakeSession(ListToolsResult(tools=[]), CallToolResult(content=[]))
    captured = {}
    _patch_session(monkeypatch, session, captured)
    client = McpToolClient("http://cap.local/mcp/cockpit")
    with pytest.raises(failure):
        async with client.turn(authorization="Bearer alice"):
            raise failure()
    assert captured["closed"] == 1
    assert client._turn_session is None
    assert client._turn_authorization is None
    async with client.turn(authorization="Bearer bob"):
        await client.list_tools(authorization="Bearer bob")
    assert session.initializations == 2
