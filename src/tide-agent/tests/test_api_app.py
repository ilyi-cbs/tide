"""Integration tests for the FastAPI transport: SSE streaming, thread
rehydration, health checks, authentication and thread ownership, the 409
pending-input guard and the interrupt/resume round trip -- all against an
in-process fake LLM/tool client and fake identity, so no CAP/litellm network
call ever happens.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from ag_ui.core.types import ResumeEntry, RunAgentInput, UserMessage
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from agent.adapters.fakes import FakeIdentity, FakeToolClient, ScriptedFakeChatModel
from agent.config import Settings, get_settings
from agent.ports.tools import ToolCallResult, ToolFailure, ToolSpec

# ilyesse.hettenbach@cbs-consulting.de:alice
ADMIN_USER = "Basic aWx5ZXNzZS5oZXR0ZW5iYWNoQGNicy1jb25zdWx0aW5nLmRlOmFsaWNl"
BOB = "Basic Ym9iOmJvYg=="  # bob:bob


def _profiled_tools(
    tools: list[ToolSpec], results: dict[str, ToolCallResult] | None = None
) -> FakeToolClient:
    """The app's MCP endpoint supplies its own catalog and instructions."""
    return FakeToolClient(tools=tools, results=results)


def _sse_events(text: str) -> list[dict]:
    events = []
    for chunk in text.split("\n\n"):
        chunk = chunk.strip()
        if not chunk:
            continue
        assert chunk.startswith("data: ")
        events.append(json.loads(chunk[len("data: ") :]))
    return events


def _make_settings(tmp_path) -> Settings:
    return Settings(
        _env_file=None,
        checkpoint_db=str(tmp_path / "checkpoints.sqlite"),
        llm_fake=True,
        max_concurrent_turns=50,
        turn_timeout_s=5,
    )


@pytest.fixture
def client(tmp_path, monkeypatch) -> Iterator[TestClient]:
    from agent import config as config_module
    from agent.api import app as app_module

    settings = _make_settings(tmp_path)
    get_settings.cache_clear()
    monkeypatch.setattr(config_module, "get_settings", lambda: settings)
    monkeypatch.setattr(app_module, "get_settings", lambda: settings)

    app_module.app.state.identity = FakeIdentity(
        users={ADMIN_USER: "ilyesse.hettenbach@cbs-consulting.de", BOB: "bob"}
    )
    with TestClient(app_module.app) as test_client:
        test_client.headers["X-Tide-App-Id"] = "cockpit"
        test_client.headers["Authorization"] = ADMIN_USER
        yield test_client
    del app_module.app.state.identity
    get_settings.cache_clear()


def _run_input(thread_id: str, run_id: str, text: str, resume: list | None = None) -> dict:
    payload = RunAgentInput(
        threadId=thread_id,
        runId=run_id,
        messages=[UserMessage(id="m1", role="user", content=text)],
        resume=resume,
    )
    return payload.model_dump(by_alias=True, exclude_none=True)


@pytest.mark.parametrize("status", ["pending", "failed", "unknown"])
def test_incomplete_tool_outcomes_are_reported_over_sse_and_history(client, monkeypatch, status):
    from agent.api import app as app_module

    data = {"ID": "run-1", "status": status, "payload": "x" * 30_000}
    response = ToolCallResult(json.dumps(data), False, data)
    if status == "unknown":
        response = ToolCallResult(
            "connection lost",
            True,
            error=ToolFailure("OUTCOME_UNKNOWN", "connection lost", reference="correlation-1"),
        )
    tools = _profiled_tools(
        [ToolSpec("start_prediction", "", {}, True)], {"start_prediction": response}
    )
    llm = ScriptedFakeChatModel(
        responses=[
            AIMessage(
                content="", tool_calls=[{"name": "start_prediction", "args": {}, "id": "p1"}]
            ),
            AIMessage(content="Everything completed successfully."),
        ]
    )
    monkeypatch.setattr(app_module, "build_llm", lambda settings: llm)
    monkeypatch.setattr(app_module, "build_tool_client", lambda settings, app_id: tools)
    with client.stream(
        "POST", "/agent", json=_run_input("incomplete", "run-1", "start_prediction")
    ) as run:
        assert run.status_code == 200
        events = _sse_events(run.read().decode())
    (turn,) = [
        event for event in events if event["type"] == "CUSTOM" and event["name"] == "tide.turn"
    ]
    assert f"outcome {status}" in turn["value"]["append"]
    assert "do not claim successful completion" in turn["value"]["append"]
    history = client.get("/threads/incomplete")
    assert history.status_code == 200
    assert f"outcome {status}" in history.json()["messages"][-1]["content"]
    assert [name for name, _ in tools.calls] == ["profile", "start_prediction"]


def test_healthz(client: TestClient):
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "llm_fake": True}


def test_each_stream_owns_one_mcp_session(client, monkeypatch):
    from mcp.types import CallToolResult, ListToolsResult, Tool, ToolAnnotations
    from tests.test_mcp_tools import _FakeSession, _patch_session

    from agent.adapters.mcp_tools import McpToolClient
    from agent.api import app as app_module

    session = _FakeSession(
        ListToolsResult(
            tools=[
                Tool(
                    name="list_feeds",
                    inputSchema={},
                    annotations=ToolAnnotations(readOnlyHint=True),
                ),
            ]
        ),
        CallToolResult(content=[]),
    )
    captured = {}
    _patch_session(monkeypatch, session, captured)

    async def profile(self, *, authorization):
        assert authorization == ADMIN_USER
        return {"checked": False}

    monkeypatch.setattr(McpToolClient, "profile", profile)
    monkeypatch.setattr(
        app_module, "build_tool_client", lambda settings, app_id: McpToolClient("http://cap.local")
    )
    monkeypatch.setattr(
        app_module,
        "build_llm",
        lambda settings: ScriptedFakeChatModel(
            responses=[
                AIMessage(
                    content="", tool_calls=[{"name": "list_feeds", "args": {}, "id": "read"}]
                ),
                AIMessage(content="done"),
            ]
        ),
    )
    for index in range(2):
        with client.stream(
            "POST", "/agent", json=_run_input(f"scope-{index}", "r1", "lookup")
        ) as response:
            assert response.status_code == 200
            events = _sse_events(response.read().decode())
        assert not any(event["type"] == "RUN_ERROR" for event in events)
        assert any(event["type"] == "TOOL_CALL_RESULT" for event in events)
        assert session.initializations == index + 1
        assert captured["closed"] == index + 1
    assert session.catalog_reads == 2


def test_oversized_message_is_rejected_before_graph_execution(client):
    response = client.post("/agent", json=_run_input("large", "r1", "x" * 16_001))
    assert response.status_code == 422


def test_oversized_request_body_is_rejected(client):
    response = client.post(
        "/agent", content=b"x" * 1_048_577, headers={"content-type": "application/json"}
    )
    assert response.status_code == 413
    assert response.headers.get("x-correlation-id")


def test_turn_rejects_thread_ids_that_cannot_be_rehydrated(client: TestClient):
    response = client.post("/agent", json=_run_input("invalid/thread", "run-1", "hi"))
    assert response.status_code == 400


@pytest.mark.parametrize(
    "context",
    [
        {"version": 2, "app": "cockpit", "surface": "cockpit.overview"},
        {"version": 1, "app": "cockpit", "surface": "cockpit.not-a-page"},
        {"version": 1, "app": "cockpit", "surface": "cockpit.overview", "extra": "not-allowed"},
        {
            "version": 1,
            "app": "cockpit",
            "surface": "cockpit.overview",
            "selection": {"itemIds": [str(i) for i in range(21)]},
        },
    ],
)
def test_page_context_is_validated_at_the_http_boundary(client: TestClient, context: dict):
    payload = _run_input("context-invalid", "run-1", "hi")
    payload["pageContext"] = context
    response = client.post("/agent", json=payload, headers={"X-Tide-App-Id": "cockpit"})
    assert response.status_code == 422


def test_title_generation_obeys_the_shared_concurrency_limit(client: TestClient):
    from agent.api import app as app_module

    semaphore = app_module.app.state.turn_semaphore
    previous = semaphore._value
    semaphore._value = 0
    try:
        response = client.post("/threads/title-busy/title", json={"text": "Check delivery"})
        assert response.status_code == 429
    finally:
        semaphore._value = previous


def test_agent_rejects_missing_or_unknown_app_id(client: TestClient):
    client.headers.pop("X-Tide-App-Id")
    assert client.post("/agent", json=_run_input("missing", "run-1", "hi")).status_code == 400
    response = client.post(
        "/agent",
        json=_run_input("unknown", "run-1", "hi"),
        headers={"X-Tide-App-Id": "unknown"},
    )
    assert response.status_code == 400


def test_agent_accepts_the_cockpit_app(client: TestClient, monkeypatch):
    _fake_turn(monkeypatch)
    assert _turn(client, "cockpit-thread", **{"X-Tide-App-Id": "cockpit"}) == 200


def test_agent_run_streams_final_answer(client: TestClient, monkeypatch):
    from agent.api import app as app_module

    llm = ScriptedFakeChatModel(responses=[AIMessage(content="hello from fake llm")])
    tools = FakeToolClient(tools=[])
    monkeypatch.setattr(app_module, "build_llm", lambda settings: llm)
    monkeypatch.setattr(app_module, "build_tool_client", lambda settings, app_id: tools)

    with client.stream("POST", "/agent", json=_run_input("thread-1", "run-1", "hi")) as response:
        assert response.status_code == 200
        events = _sse_events(response.read().decode())

    types = [e["type"] for e in events]
    assert "RUN_STARTED" in types
    assert "RUN_FINISHED" in types
    text_content = "".join(e["delta"] for e in events if e["type"] == "TEXT_MESSAGE_CONTENT")
    assert text_content == "hello from fake llm"


def test_thread_rehydration_after_a_turn(client: TestClient, monkeypatch):
    from agent.api import app as app_module

    llm = ScriptedFakeChatModel(responses=[AIMessage(content="remembered")])
    tools = FakeToolClient(tools=[])
    monkeypatch.setattr(app_module, "build_llm", lambda settings: llm)
    monkeypatch.setattr(app_module, "build_tool_client", lambda settings, app_id: tools)

    with client.stream(
        "POST", "/agent", json=_run_input("thread-2", "run-1", "remember this")
    ) as response:
        response.read()

    thread = client.get("/threads/thread-2")
    assert thread.status_code == 200
    body = thread.json()
    assert body["pending_interrupt"] is False
    contents = [m.get("content") for m in body["messages"]]
    assert "remember this" in contents
    assert "remembered" in contents


def test_thread_title_uses_the_configured_llm_and_returns_a_short_clean_title(
    client: TestClient, monkeypatch
):
    from agent.api import app as app_module

    llm = ScriptedFakeChatModel(
        responses=[
            AIMessage(content='Title: "Check delayed orders for plant DE11 and supplier S1"')
        ]
    )
    monkeypatch.setattr(app_module, "build_llm", lambda settings: llm)

    response = client.post(
        "/threads/title-thread/title",
        json={"text": "Please check delayed orders for plant DE11 and supplier S1"},
        headers={"X-Tide-App-Id": "cockpit"},
    )

    assert response.status_code == 200
    assert response.json() == {"title": "Check delayed orders for plant DE11"}
    assert len(response.json()["title"]) <= 48


def test_thread_title_truncates_unusually_long_model_output(client: TestClient, monkeypatch):
    from agent.api import app as app_module

    llm = ScriptedFakeChatModel(responses=[AIMessage(content="unbroken" * 20)])
    monkeypatch.setattr(app_module, "build_llm", lambda settings: llm)
    response = client.post(
        "/threads/long-title-thread/title",
        json={"text": "Make a title"},
        headers={"X-Tide-App-Id": "cockpit"},
    )
    assert response.status_code == 200
    assert len(response.json()["title"]) <= 48


def test_thread_title_is_private_and_rejects_empty_text(client: TestClient, monkeypatch):
    from agent.api import app as app_module

    llm = ScriptedFakeChatModel(responses=[AIMessage(content="Short title")])
    monkeypatch.setattr(app_module, "build_llm", lambda settings: llm)

    response = client.post(
        "/threads/title-thread/title",
        json={"text": "A title request"},
        headers={"X-Tide-App-Id": "cockpit"},
    )
    assert response.status_code == 200
    response = client.post(
        "/threads/title-thread/title",
        json={"text": "A title request"},
        headers={"Authorization": BOB, "X-Tide-App-Id": "cockpit"},
    )
    assert response.status_code == 404
    assert (
        client.post(
            "/threads/title-thread/title",
            json={"text": ""},
            headers={"X-Tide-App-Id": "cockpit"},
        ).status_code
        == 422
    )


def test_write_tool_call_interrupts_and_resumes_over_http(client: TestClient, monkeypatch):
    from agent.api import app as app_module

    tool = ToolSpec(
        name="start_prediction", description="Starts a prediction", input_schema={}, read_only=False
    )
    first = AIMessage(
        content="", tool_calls=[{"name": "start_prediction", "args": {}, "id": "call-1"}]
    )
    second = AIMessage(content="predicted")
    llm = ScriptedFakeChatModel(responses=[first, second])
    tools = _profiled_tools(
        [tool],
        {
            "start_prediction": ToolCallResult(
                content='{"ID":"run-1","status":"succeeded"}',
                is_error=False,
                data={"ID": "run-1", "status": "succeeded"},
            )
        },
    )
    monkeypatch.setattr(app_module, "build_llm", lambda settings: llm)
    monkeypatch.setattr(app_module, "build_tool_client", lambda settings, app_id: tools)

    with client.stream(
        "POST", "/agent", json=_run_input("thread-3", "run-1", "predict something")
    ) as response:
        events = _sse_events(response.read().decode())

    assert any(e["type"] == "RUN_FINISHED" for e in events)
    thread = client.get("/threads/thread-3")
    assert thread.json()["pending_interrupt"] is True

    finished = next(e for e in events if e["type"] == "RUN_FINISHED")
    assert finished["outcome"]["type"] == "interrupt"
    interrupt_id = thread.json()["interrupt"]["id"]

    resume = [
        ResumeEntry(
            interruptId=interrupt_id,
            status="resolved",
            payload={"approved_tool_call_ids": ["call-1"]},
        )
    ]
    with client.stream(
        "POST",
        "/agent",
        json=_run_input("thread-3", "run-2", "predict something", resume=resume),
    ) as response:
        assert response.status_code == 200
        resumed_events = _sse_events(response.read().decode())

    resumed_text = "".join(
        e["delta"] for e in resumed_events if e["type"] == "TEXT_MESSAGE_CONTENT"
    )
    assert resumed_text == "predicted"

    thread = client.get("/threads/thread-3")
    assert thread.json()["pending_interrupt"] is False


def test_concurrent_requests_on_same_thread_return_409(client: TestClient, monkeypatch):
    from agent.api import app as app_module

    release = asyncio.Event()

    class SlowLLM(ScriptedFakeChatModel):
        # `astream_events` (used internally by ag_ui_langgraph) calls
        # `_astream`, not `_agenerate` -- ScriptedFakeChatModel implements
        # `_astream`, so the delay must go there too or it's bypassed.
        async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
            await release.wait()
            stream = super()._astream(messages, stop=stop, run_manager=run_manager, **kwargs)
            async for chunk in stream:
                yield chunk

    llm = SlowLLM(responses=[AIMessage(content="done")])
    tools = FakeToolClient(tools=[])
    monkeypatch.setattr(app_module, "build_llm", lambda settings: llm)
    monkeypatch.setattr(app_module, "build_tool_client", lambda settings, app_id: tools)

    import threading

    first_response = {}

    def run_first():
        with client.stream(
            "POST", "/agent", json=_run_input("thread-4", "run-1", "hi")
        ) as response:
            first_response["status"] = response.status_code
            response.read()

    thread = threading.Thread(target=run_first)
    thread.start()
    try:
        # Give the first request a moment to acquire the per-thread lock
        # before the second one races it. The SlowLLM keeps the first turn
        # blocked (holding the lock) until `release` is set below.
        import time

        time.sleep(0.1)
        second = client.post("/agent", json=_run_input("thread-4", "run-2", "hi"))
        assert second.status_code == 409
    finally:
        release.set()
        thread.join()


def _fake_turn(monkeypatch, text: str = "ok") -> None:
    from agent.api import app as app_module

    llm = ScriptedFakeChatModel(responses=[AIMessage(content=text)])
    monkeypatch.setattr(app_module, "build_llm", lambda settings: llm)
    monkeypatch.setattr(
        app_module, "build_tool_client", lambda settings, app_id: FakeToolClient(tools=[])
    )


def _turn(client: TestClient, thread_id: str, **headers) -> int:
    with client.stream(
        "POST", "/agent", json=_run_input(thread_id, "run-1", "hi"), headers=headers
    ) as response:
        response.read()
        return response.status_code


@pytest.mark.parametrize("authorization", [None, "Basic bWFsbG9yeTp4"])
def test_agent_and_threads_require_a_known_caller(client: TestClient, authorization):
    headers = {"Authorization": authorization} if authorization else {}
    if authorization is None:
        client.headers.pop("Authorization")
    assert (
        client.post("/agent", json=_run_input("t", "r", "hi"), headers=headers).status_code == 401
    )
    assert client.get("/threads/t", headers=headers).status_code == 401
    assert client.get("/readyz", headers=headers).status_code == 401
    assert client.get("/healthz", headers=headers).status_code == 200


def test_threads_belong_to_the_user_who_started_them(client: TestClient, monkeypatch):
    _fake_turn(monkeypatch, "secret plan")
    assert _turn(client, "admin-thread") == 200

    own = client.get("/threads/admin-thread")
    assert "secret plan" in [m.get("content") for m in own.json()["messages"]]

    # bob can neither read nor continue ilyesse.hettenbach@cbs-consulting.de's thread;
    # both look like "no such thread"
    assert client.get("/threads/admin-thread", headers={"Authorization": BOB}).status_code == 404
    assert _turn(client, "admin-thread", Authorization=BOB) == 404
    assert (
        client.post(
            "/threads/admin-thread/title",
            json={"text": "guess the title"},
            headers={"Authorization": BOB, "X-Tide-App-Id": "cockpit"},
        ).status_code
        == 404
    )


def test_unknown_app_is_rejected(client: TestClient, monkeypatch):
    _fake_turn(monkeypatch)
    assert _turn(client, "t", **{"X-Tide-App-Id": "other"}) == 400


def test_unstarted_thread_reads_as_empty(client: TestClient):
    body = client.get("/threads/not-started-yet").json()
    assert body["messages"] == []
    assert body["pending_interrupt"] is False


def test_rejects_malformed_thread_ids(client: TestClient):
    assert client.get("/threads/" + "x" * 129).status_code == 422
    assert client.get("/threads/a%20b").status_code == 422
    too_long = _run_input("x" * 129, "run-1", "hi")
    assert client.post("/agent", json=too_long).status_code == 400


def test_readyz_reports_the_verified_user(client: TestClient):
    assert client.get("/readyz").json() == {
        "status": "ready",
        "user": "ilyesse.hettenbach@cbs-consulting.de",
    }


def test_errors_reach_the_client_without_internal_detail(client: TestClient, monkeypatch):
    from agent.api import app as app_module

    class ExplodingLLM(ScriptedFakeChatModel):
        async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
            raise RuntimeError("db password is hunter2")
            yield  # pragma: no cover

    llm = ExplodingLLM(responses=[AIMessage(content="never")])
    monkeypatch.setattr(app_module, "build_llm", lambda settings: llm)
    monkeypatch.setattr(
        app_module, "build_tool_client", lambda settings, app_id: FakeToolClient(tools=[])
    )

    with client.stream(
        "POST",
        "/agent",
        json=_run_input("boom", "run-1", "hi"),
        headers={"X-Correlation-Id": "cid-42"},
    ) as response:
        assert response.headers["x-correlation-id"] == "cid-42"
        events = _sse_events(response.read().decode())

    errors = [e for e in events if e["type"] == "RUN_ERROR"]
    assert errors, events
    assert all("hunter2" not in str(e) for e in events)
    assert errors[0]["message"] == "the assistant could not finish this turn (ref cid-42)"


def test_new_message_while_approval_pending_is_409(client: TestClient, monkeypatch):
    from agent.api import app as app_module

    tool = ToolSpec(
        name="start_prediction", description="Predicts", input_schema={}, read_only=False
    )
    llm = ScriptedFakeChatModel(
        responses=[
            AIMessage(content="", tool_calls=[{"name": "start_prediction", "args": {}, "id": "c1"}])
        ]
    )
    monkeypatch.setattr(app_module, "build_llm", lambda settings: llm)
    monkeypatch.setattr(
        app_module, "build_tool_client", lambda settings, app_id: _profiled_tools([tool])
    )

    assert _turn(client, "pending") == 200
    assert client.get("/threads/pending").json()["pending_interrupt"] is True

    response = client.post("/agent", json=_run_input("pending", "run-2", "something else"))
    assert response.status_code == 409
    assert response.json()["detail"] == "thread is waiting for an approval decision"
    # the rejected request released the thread lock: deciding still works
    interrupt_id = client.get("/threads/pending").json()["interrupt"]["id"]
    resume = [ResumeEntry(interruptId=interrupt_id, status="resolved", payload={})]
    with client.stream(
        "POST", "/agent", json=_run_input("pending", "run-3", "x", resume=resume)
    ) as decided:
        assert decided.status_code == 200


def test_credentials_reach_the_tools_but_never_a_checkpoint(client: TestClient, monkeypatch):
    """Contract with ag-ui-langgraph internals (api/agui.py, pinned exactly):
    the request's Authorization travels via runtime context to the tool
    ports and is never written to the checkpoint store."""
    from agent.api import app as app_module

    seen: list[str | None] = []

    class RecordingTools(FakeToolClient):
        async def list_tools(self, *, authorization):
            seen.append(authorization)
            return await super().list_tools(authorization=authorization)

        async def call_tool(self, name, arguments, *, authorization):
            seen.append(authorization)
            return await super().call_tool(name, arguments, authorization=authorization)

    lookup = ToolSpec(
        name="get_prediction_run", description="Reads", input_schema={}, read_only=True
    )
    tools = RecordingTools(tools=[lookup])
    llm = ScriptedFakeChatModel(
        responses=[
            AIMessage(
                content="", tool_calls=[{"name": "get_prediction_run", "args": {}, "id": "c1"}]
            ),
            AIMessage(content="done"),
        ]
    )
    monkeypatch.setattr(app_module, "build_llm", lambda settings: llm)
    monkeypatch.setattr(app_module, "build_tool_client", lambda settings, app_id: tools)

    with client.stream("POST", "/agent", json=_run_input("thread-ctx", "run-1", "hi")) as response:
        assert response.status_code == 200
        response.read()

    assert seen and all(value == ADMIN_USER for value in seen), seen
    checkpoint_db = app_module.get_settings().checkpoint_db
    stored = b"".join(
        p.read_bytes() for p in Path(checkpoint_db).parent.glob(Path(checkpoint_db).name + "*")
    )
    assert stored, "expected a checkpoint to be written"
    assert ADMIN_USER.encode() not in stored
    assert b"aWx5ZXNzZS5oZXR0ZW5iYWNoQGNicy1jb25zdWx0aW5nLmRlOmFsaWNl" not in stored


def test_page_context_is_ephemeral_and_resolved_by_cap(client: TestClient, monkeypatch):
    from agent.api import app as app_module

    class ContextTools(FakeToolClient):
        async def resolve_context(self, context, *, authorization):
            assert authorization == ADMIN_USER
            hint = json.loads(context)
            assert hint["surface"] == "cockpit.delivery-risk-detail"
            return await super().resolve_context(context, authorization=authorization)

    tools = ContextTools(
        tools=[],
        instructions="base",
        context={
            "valid": True,
            "profile": "delivery-risk-detail",
            "canonicalContext": json.dumps(
                {
                    "surface": "cockpit.delivery-risk-detail",
                    "entity": {"kind": "case", "id": "delivery:1/10"},
                }
            ),
            "instructions": "Read current case first.",
        },
    )
    llm = ScriptedFakeChatModel(responses=[AIMessage(content="verified")])
    monkeypatch.setattr(app_module, "build_llm", lambda settings: llm)
    monkeypatch.setattr(app_module, "build_tool_client", lambda settings, app_id: tools)
    payload = _run_input("context-ephemeral", "run-1", "Explain this")
    payload["pageContext"] = {
        "version": 1,
        "app": "cockpit",
        "surface": "cockpit.delivery-risk-detail",
        "entity": {"kind": "case", "id": "delivery:1/10"},
    }
    with client.stream(
        "POST", "/agent", json=payload, headers={"X-Tide-App-Id": "cockpit"}
    ) as response:
        assert response.status_code == 200
        response.read()
    assert [name for name, _ in tools.calls] == ["profile", "resolve_context"]
    checkpoint_db = app_module.get_settings().checkpoint_db
    stored = b"".join(
        path.read_bytes()
        for path in Path(checkpoint_db).parent.glob(Path(checkpoint_db).name + "*")
    )
    assert b"delivery:1/10" not in stored


def test_page_context_rejects_cross_app_and_excessive_payload(client: TestClient):
    payload = _run_input("context-cross-app", "run-1", "hi")
    payload["pageContext"] = {"version": 1, "app": "cockpit", "surface": "cockpit.overview"}
    response = client.post("/agent", json=payload, headers={"X-Tide-App-Id": "other"})
    assert response.status_code == 400

    payload["pageContext"] = {
        "version": 1,
        "app": "cockpit",
        "surface": "cockpit.overview",
        "selection": {"itemIds": [str(index) for index in range(21)]},
    }
    response = client.post("/agent", json=payload, headers={"X-Tide-App-Id": "cockpit"})
    assert response.status_code == 422


def test_tool_results_are_streamed_before_the_answer(client: TestClient, monkeypatch):
    """The graph answers calls from plain nodes, not LangChain tools, so the
    library alone never emits TOOL_CALL_RESULT (clients would show the call
    as in progress forever); `TideAgent` emits one per call, also for
    rejected calls."""
    from agent.api import app as app_module

    lookup = ToolSpec(
        name="get_prediction_run", description="Reads", input_schema={}, read_only=True
    )
    tools = _profiled_tools(
        [lookup], {"get_prediction_run": ToolCallResult(content='{"a": 1}', is_error=False)}
    )
    calls = [
        {"name": "get_prediction_run", "args": {}, "id": "c1"},
        {"name": "notInThisApp", "args": {}, "id": "c2"},
    ]
    llm = ScriptedFakeChatModel(
        responses=[AIMessage(content="", tool_calls=calls), AIMessage(content="done")]
    )
    monkeypatch.setattr(app_module, "build_llm", lambda settings: llm)
    monkeypatch.setattr(app_module, "build_tool_client", lambda settings, app_id: tools)

    with client.stream("POST", "/agent", json=_run_input("thread-res", "run-1", "hi")) as response:
        events = _sse_events(response.read().decode())

    results = [e for e in events if e["type"] == "TOOL_CALL_RESULT"]
    assert sorted(e["toolCallId"] for e in results) == ["c1", "c2"]
    assert next(e for e in results if e["toolCallId"] == "c1")["content"] == '{"a": 1}'
    types = [e["type"] for e in events]
    last_result = max(i for i, e in enumerate(events) if e["type"] == "TOOL_CALL_RESULT")
    assert last_result < types.index("TEXT_MESSAGE_START")
    assert all(
        types.index("TOOL_CALL_END") < i for i, t in enumerate(types) if t == "TOOL_CALL_RESULT"
    )


def test_failed_tools_and_turn_checks_reach_the_client(client: TestClient, monkeypatch):
    """Cockpit: a failed call carries status "error" on TOOL_CALL_RESULT, a
    result card travels as `artifact`, and the end-of-turn check is sent as a
    `tide.turn` custom event (the answer was already streamed)."""
    from tests.test_cockpit_chat import CHECKS

    from agent.api import app as app_module

    profile = {
        "actionTools": [],
        "checks": json.dumps(CHECKS),
    }
    card = {"kind": "prediction", "id": "q1"}
    specs = [
        ToolSpec(name="list_cases", description="", input_schema={}, read_only=True),
        ToolSpec(name="start_prediction", description="", input_schema={}, read_only=True),
    ]
    tools = FakeToolClient(
        tools=specs,
        profile=profile,
        results={
            "list_cases": ToolCallResult("Error calling list_cases: not implemented yet", True),
            "start_prediction": ToolCallResult(
                "{}",
                False,
                {
                    "ID": "run-1",
                    "status": "succeeded",
                    "verdict": "pass",
                    "card": card,
                },
            ),
        },
    )
    calls = [
        {"name": "start_prediction", "args": {}, "id": "c2"},
        {"name": "list_cases", "args": {}, "id": "c1"},
    ]
    llm = ScriptedFakeChatModel(
        responses=[
            AIMessage(content="", tool_calls=calls),
            AIMessage(content="I prepared a draft."),
        ]
    )
    monkeypatch.setattr(app_module, "build_llm", lambda settings: llm)
    monkeypatch.setattr(app_module, "build_tool_client", lambda settings, app_id: tools)

    body = _run_input("thread-ck", "run-1", "hi")
    with client.stream("POST", "/agent", json=body, headers={"X-Tide-App-Id": "cockpit"}) as r:
        events = _sse_events(r.read().decode())

    results = {e["toolCallId"]: e for e in events if e["type"] == "TOOL_CALL_RESULT"}
    assert results["c1"]["status"] == "error"
    assert results["c2"]["status"] == "success"
    assert results["c2"]["artifact"] == {"card": card}
    (turn,) = [e for e in events if e["type"] == "CUSTOM" and e["name"] == "tide.turn"]
    assert "No action was prepared." in turn["value"]["append"]
    assert "not implemented yet" in turn["value"]["append"]
    assert turn["value"] == {
        "messageId": turn["value"]["messageId"],
        "append": turn["value"]["append"],
    }

    thread = client.get("/threads/thread-ck").json()
    assert thread["artifacts"] == {"c2": {"card": card}}
    assert "No action was prepared." in thread["messages"][-1]["content"]
