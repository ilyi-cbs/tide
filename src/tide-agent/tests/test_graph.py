"""Unit tests for the compiled graph: prepare -> llm -> route -> [approve] -> tools -> llm.

Drives `build_graph()` end to end with a scripted fake LLM and an in-memory
tool client and checkpointer.
"""

from __future__ import annotations

import json
import os

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from agent.adapters.fakes import (
    FakeToolClient,
    ScriptedFakeChatModel,
    offline_answer,
)
from agent.adapters.mcp_tools import McpToolClient
from agent.adapters.sqlite_ckpt import serializer
from agent.graph.build import build_graph
from agent.ports.tools import ToolCallResult, ToolFailure, ToolSpec


def _config(thread_id: str) -> dict:
    return {"configurable": {"thread_id": thread_id}}


def _with_profile(tools: FakeToolClient, app_id: str = "tabpfn-playground") -> FakeToolClient:
    tools._instructions = f"rules for {app_id}"
    tools._profile = {"checked": False}
    return tools


def _command_spec(name: str) -> ToolSpec:
    return ToolSpec(
        name,
        "",
        {
            "type": "object",
            "properties": {"commandID": {"type": "string"}, "caseID": {"type": "string"}},
            "required": ["commandID", "caseID"],
        },
        False,
    )


async def test_no_tool_calls_finishes_immediately():
    llm = ScriptedFakeChatModel(responses=[AIMessage(content="final answer")])
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    context = {
        "llm": llm,
        "tool_catalog": FakeToolClient(tools=[]),
        "tool_executor": FakeToolClient(tools=[]),
        "authorization": None,
        "max_steps": 8,
        "max_tool_calls": 16,
    }

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="hi")]}, _config("t1"), context=context
    )

    assert result["messages"][-1].content == "final answer"


@pytest.mark.parametrize("revoked_from", ["catalog", "instructions", "profile", "schema"])
async def test_approval_resume_rechecks_current_tool_permission(revoked_from):
    tool = ToolSpec("start_prediction", "Starts a prediction", {}, False)
    tools = _with_profile(
        FakeToolClient(
            tools=[tool],
            results={
                "start_prediction": ToolCallResult(
                    "{}", False, {"ID": "run-1", "status": "succeeded"}
                )
            },
        )
    )
    llm = ScriptedFakeChatModel(
        responses=[
            AIMessage(
                content="", tool_calls=[{"name": "start_prediction", "args": {}, "id": "write"}]
            ),
            AIMessage(content="The tool is no longer available."),
        ]
    )
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    config = _config("revoked-approval")
    context = {
        "llm": llm,
        "tool_catalog": tools,
        "tool_executor": tools,
        "authorization": None,
        "max_steps": 8,
        "max_tool_calls": 16,
    }
    interrupted = await graph.ainvoke(
        {"messages": [HumanMessage(content="start_prediction")]}, config, context=context
    )
    assert interrupted["__interrupt__"]
    if revoked_from == "catalog":
        tools._tools = [spec for spec in tools._tools if spec.name != "start_prediction"]
    elif revoked_from == "schema":
        tools._tools = [
            ToolSpec(
                spec.name,
                spec.description,
                {"type": "object", "required": ["newGuard"]},
                spec.read_only,
            )
            if spec.name == "start_prediction"
            else spec
            for spec in tools._tools
        ]
    elif revoked_from == "instructions":
        tools._instructions = ""
    else:
        tools._profile = ConnectionError("profile unavailable")
    result = await graph.ainvoke(
        Command(resume={"approved_tool_call_ids": ["write"]}), config, context=context
    )
    assert not any(name == "start_prediction" for name, _ in tools.calls)
    assert result["outcomes"][0].success is False
    assert result["messages"][-1].content == "The tool is no longer available."


async def test_read_only_tool_call_runs_without_interrupt():
    tool = ToolSpec(name="list_feeds", description="Lists feeds", input_schema={}, read_only=True)
    first = AIMessage(content="", tool_calls=[{"name": "list_feeds", "args": {}, "id": "call-1"}])
    second = AIMessage(content="done")
    llm = ScriptedFakeChatModel(responses=[first, second])
    tools = _with_profile(
        FakeToolClient(
            tools=[tool], results={"list_feeds": ToolCallResult(content="[]", is_error=False)}
        )
    )
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    context = {
        "llm": llm,
        "tool_catalog": tools,
        "tool_executor": tools,
        "authorization": None,
        "max_steps": 8,
        "max_tool_calls": 16,
    }

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="list feeds")]}, _config("t2"), context=context
    )

    assert result["messages"][-1].content == "done"
    tool_messages = [m for m in result["messages"] if getattr(m, "tool_call_id", None) == "call-1"]
    assert tool_messages[0].content == "[]"


async def test_write_tool_call_interrupts_then_resumes_on_approval():
    tool = ToolSpec(
        name="start_prediction", description="Starts a prediction", input_schema={}, read_only=False
    )
    first = AIMessage(
        content="", tool_calls=[{"name": "start_prediction", "args": {}, "id": "call-1"}]
    )
    second = AIMessage(content="predicted")
    llm = ScriptedFakeChatModel(responses=[first, second])
    tools = _with_profile(
        FakeToolClient(
            tools=[tool],
            results={
                "start_prediction": ToolCallResult(
                    content='{"ID":"run-1","status":"succeeded"}',
                    is_error=False,
                    data={"ID": "run-1", "status": "succeeded"},
                )
            },
        )
    )
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    context = {
        "llm": llm,
        "tool_catalog": tools,
        "tool_executor": tools,
        "authorization": None,
        "max_steps": 8,
        "max_tool_calls": 16,
    }
    config = _config("t3")

    interrupted = await graph.ainvoke(
        {"messages": [HumanMessage(content="predict something")]}, config, context=context
    )

    assert "__interrupt__" in interrupted
    (payload,) = interrupted["__interrupt__"]
    assert payload.value["calls"][0]["name"] == "start_prediction"

    resumed = await graph.ainvoke(
        Command(resume={"approved_tool_call_ids": ["call-1"]}), config, context=context
    )

    assert resumed["messages"][-1].content == "predicted"


async def test_write_tool_call_rejected_feeds_decline_back_to_llm():
    tool = ToolSpec(
        name="start_prediction", description="Starts a prediction", input_schema={}, read_only=False
    )
    first = AIMessage(
        content="", tool_calls=[{"name": "start_prediction", "args": {}, "id": "call-1"}]
    )
    second = AIMessage(content="okay, not doing that")
    llm = ScriptedFakeChatModel(responses=[first, second])
    tools = _with_profile(FakeToolClient(tools=[tool]))
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    context = {
        "llm": llm,
        "tool_catalog": tools,
        "tool_executor": tools,
        "authorization": None,
        "max_steps": 8,
        "max_tool_calls": 16,
    }
    config = _config("t4")

    await graph.ainvoke(
        {"messages": [HumanMessage(content="predict something")]}, config, context=context
    )
    resumed = await graph.ainvoke(
        Command(resume={"approved_tool_call_ids": []}), config, context=context
    )

    declined = [m for m in resumed["messages"] if getattr(m, "tool_call_id", None) == "call-1"]
    assert declined[0].content == "User declined this action."
    assert resumed["messages"][-1].content == "okay, not doing that"


async def test_read_calls_complete_before_a_mixed_batch_needs_approval():
    read = ToolSpec(name="list_feeds", description="Lists feeds", input_schema={}, read_only=True)
    write = ToolSpec(
        name="start_prediction", description="Starts a prediction", input_schema={}, read_only=False
    )
    tools = _with_profile(
        FakeToolClient(
            tools=[read, write],
            results={
                "list_feeds": ToolCallResult(content='["orders"]', is_error=False),
                "start_prediction": ToolCallResult(
                    "{}", False, {"ID": "run-1", "status": "succeeded"}
                ),
            },
        )
    )
    llm = ScriptedFakeChatModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {"name": "list_feeds", "args": {}, "id": "read"},
                    {"name": "start_prediction", "args": {}, "id": "write"},
                ],
            ),
            AIMessage(content="approved result"),
        ]
    )
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    context = {
        "llm": llm,
        "tool_catalog": tools,
        "tool_executor": tools,
        "authorization": None,
        "max_steps": 8,
        "max_tool_calls": 16,
    }
    config = _config("mixed")

    interrupted = await graph.ainvoke(
        {"messages": [HumanMessage(content="inspect then predict")]}, config, context=context
    )

    assert tools.calls == [("profile", {}), ("list_feeds", {})]
    read_result = next(
        message
        for message in interrupted["messages"]
        if getattr(message, "tool_call_id", None) == "read"
    )
    assert read_result.content == '["orders"]'
    (approval,) = interrupted["__interrupt__"]
    assert [call["id"] for call in approval.value["calls"]] == ["write"]

    resumed = await graph.ainvoke(
        Command(resume={"approved_tool_call_ids": ["write"]}), config, context=context
    )
    assert resumed["messages"][-1].content == "approved result"


async def test_failed_step_stops_remaining_plan_steps():
    first = ToolSpec(name="list_feeds", description="Lists feeds", input_schema={}, read_only=True)
    second = ToolSpec(
        name="describe_feed", description="Describes a feed", input_schema={}, read_only=True
    )
    tools = _with_profile(
        FakeToolClient(
            tools=[first, second],
            results={"list_feeds": ToolCallResult("not available", True)},
        )
    )
    llm = ScriptedFakeChatModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {"name": "list_feeds", "args": {}, "id": "first"},
                    {"name": "describe_feed", "args": {"feed": "orders"}, "id": "second"},
                ],
            ),
            AIMessage(content="the first lookup failed"),
        ]
    )
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="inspect feeds")]},
        _config("failed-plan"),
        context={
            "llm": llm,
            "tool_catalog": tools,
            "tool_executor": tools,
            "authorization": None,
            "max_steps": 8,
            "max_tool_calls": 16,
        },
    )

    assert [name for name, _ in tools.calls] == ["profile", "list_feeds"]
    deferred = next(
        message
        for message in result["messages"]
        if getattr(message, "tool_call_id", None) == "second"
    )
    assert deferred.content == "Not run: replan after the prior step completed."


async def test_retryable_read_retries_before_failing():
    class FlakyTools(FakeToolClient):
        attempts = 0

        async def call_tool(self, name, arguments, *, authorization):
            if name == "list_feeds":
                self.attempts += 1
                if self.attempts == 1:
                    from agent.ports.tools import ToolFailure

                    return ToolCallResult(
                        "temporary failure",
                        True,
                        error=ToolFailure("TEMPORARY", "temporary failure", retryable=True),
                    )
                return ToolCallResult("[]", False)
            return await super().call_tool(name, arguments, authorization=authorization)

    tools = _with_profile(FlakyTools(tools=[ToolSpec("list_feeds", "", {}, True)]))
    llm = ScriptedFakeChatModel(
        responses=[
            AIMessage(content="", tool_calls=[{"name": "list_feeds", "args": {}, "id": "read"}]),
            AIMessage(content="done"),
        ]
    )
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="list feeds")]},
        _config("retry-read"),
        context={
            "llm": llm,
            "tool_catalog": tools,
            "tool_executor": tools,
            "authorization": None,
            "max_steps": 8,
            "max_tool_calls": 16,
        },
    )

    assert tools.attempts == 2
    assert (
        next(
            message
            for message in result["messages"]
            if getattr(message, "tool_call_id", None) == "read"
        ).status
        == "success"
    )


async def test_conflict_reconciles_with_the_declared_read_tool():
    from agent.ports.tools import ToolFailure

    action = ToolSpec("prepare_case_action", "", {}, False)
    pending = ToolSpec("list_pending_actions", "", {}, True)
    conflict = ToolCallResult(
        "already prepared",
        True,
        error=ToolFailure(
            "CONFLICT",
            "already prepared",
            existing_id="a1",
            reconcile_tool="list_pending_actions",
            reconcile_arguments={},
        ),
    )
    tools = _with_profile(
        FakeToolClient(
            tools=[action, pending],
            results={
                "prepare_case_action": conflict,
                "list_pending_actions": ToolCallResult("{}", False, {"pending": [{"ID": "a1"}]}),
            },
        )
    )
    llm = ScriptedFakeChatModel(
        responses=[
            AIMessage(
                content="", tool_calls=[{"name": "prepare_case_action", "args": {}, "id": "write"}]
            ),
            AIMessage(content="reused the existing draft"),
        ]
    )
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    config = _config("reconcile")
    interrupted = await graph.ainvoke(
        {"messages": [HumanMessage(content="prepare")]},
        config,
        context={
            "llm": llm,
            "tool_catalog": tools,
            "tool_executor": tools,
            "authorization": None,
            "max_steps": 8,
            "max_tool_calls": 16,
        },
    )
    (approval,) = interrupted["__interrupt__"]
    result = await graph.ainvoke(
        Command(resume={"approved_tool_call_ids": [approval.value["calls"][0]["id"]]}),
        config,
        context={
            "llm": llm,
            "tool_catalog": tools,
            "tool_executor": tools,
            "authorization": None,
            "max_steps": 8,
            "max_tool_calls": 16,
        },
    )

    tool_result = next(
        message
        for message in result["messages"]
        if getattr(message, "tool_call_id", None) == "write"
    )
    assert tool_result.status == "success"
    assert json.loads(tool_result.content)["reused"] is True


@pytest.mark.parametrize(
    ("receipt_available", "receipt_data", "reconciled"),
    [
        (True, {"caseID": "case-1", "actionID": "action-1", "sourceFingerprint": "current"}, True),
        (True, None, False),
        (True, {"caseID": "other-case", "actionID": "action-1"}, False),
        (True, {"caseID": "case-1", "actionID": "action-1", "sourceFingerprint": "stale"}, False),
        (
            True,
            {
                "caseID": "case-1",
                "actionID": "action-1",
                "sourceFingerprint": "current",
                "payloadMatched": False,
            },
            False,
        ),
        (
            True,
            {
                "caseID": "case-1",
                "actionID": "action-1",
                "sourceFingerprint": "current",
                "commandID": "other-command",
            },
            False,
        ),
        (
            True,
            {"caseID": "case-1", "sourceFingerprint": "current"},
            False,
        ),
        (
            False,
            {"caseID": "case-1", "actionID": "action-1", "sourceFingerprint": "current"},
            False,
        ),
    ],
)
async def test_uncertain_workflow_write_reconciles_only_with_authorized_receipt(
    receipt_available, receipt_data, reconciled, monkeypatch
):
    monkeypatch.setattr("agent.graph.nodes.uuid4", lambda: "cmd-1")

    class WorkflowTools(FakeToolClient):
        async def call_tool(self, name, arguments, *, authorization):
            if name == "prepare_case_action":
                raise ConnectionError("connection dropped after commit")
            return await super().call_tool(name, arguments, authorization=authorization)

    tools = WorkflowTools(
        tools=[_command_spec("prepare_case_action")],
        receipt=ToolCallResult(
            json.dumps(receipt_data),
            False,
            {"commandID": "cmd-1", "payloadMatched": True, **receipt_data}
            if receipt_data
            else None,
        )
        if receipt_available
        else ConnectionError("receipt unavailable"),
    )
    llm = ScriptedFakeChatModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "prepare_case_action",
                        "args": {
                            "caseID": "case-1",
                            "expectedFingerprint": "current",
                        },
                        "id": "write",
                    }
                ],
            ),
            AIMessage(content="Checked the result."),
        ]
    )
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    config = _config(f"workflow-receipt-{receipt_available}")
    context = {
        "llm": llm,
        "tool_catalog": tools,
        "tool_executor": tools,
        "authorization": None,
        "app_id": "cockpit",
        "max_steps": 8,
        "max_tool_calls": 16,
    }
    interrupted = await graph.ainvoke(
        {"messages": [HumanMessage(content="prepare")]}, config, context=context
    )
    assert interrupted["__interrupt__"]
    result = await graph.ainvoke(
        Command(resume={"approved_tool_call_ids": ["write"]}), config, context=context
    )

    (outcome,) = result["outcomes"]
    assert outcome.success is reconciled
    assert outcome.status == ("completed" if reconciled else "unknown")
    assert [name for name, _ in tools.calls if name == "command_result"] == ["command_result"]
    receipt_arguments = next(args for name, args in tools.calls if name == "command_result")
    assert receipt_arguments == {
        "tool": "prepare_case_action",
        "commandID": "cmd-1",
        "arguments": '{"caseID":"case-1","expectedFingerprint":"current"}',
    }
    assert outcome.call.args["commandID"] == "cmd-1"


@pytest.mark.parametrize(
    ("tool_name", "arguments"),
    [
        (
            "prepare_case_action",
            {
                "expectedFingerprint": "current",
                "responsiblePerson": "Buyer",
                "responsibleMessage": "Clarify",
            },
        ),
        (
            "prepare_case_action",
            {"expectedFingerprint": "current"},
        ),
        (
            "submit_review",
            {"expectedReviewToken": "review-token"},
        ),
    ],
)
async def test_workflow_recovery_verifies_each_supported_command_payload(
    tool_name, arguments, monkeypatch
):
    monkeypatch.setattr("agent.graph.nodes.uuid4", lambda: "cmd-1")
    payload = {
        "commandID": "cmd-1",
        "caseID": "case-1",
        "expectedModifiedAt": "2026-10-04T00:00:00.000Z",
        **arguments,
    }
    expected = {
        "caseID": payload["caseID"],
        "expectedModifiedAt": payload["expectedModifiedAt"],
        **arguments,
    }
    receipt = {
        "commandID": payload["commandID"],
        "payloadMatched": True,
        "caseID": payload["caseID"],
        "actionID": "action-1",
        "sourceFingerprint": "current",
        "submissionID": "submission-1" if tool_name == "submit_review" else "",
    }

    class WorkflowTools(FakeToolClient):
        writes = 0

        async def call_tool(self, name, arguments, *, authorization):
            if name == tool_name:
                self.writes += 1
                raise ConnectionError("lost committed response")
            return await super().call_tool(name, arguments, authorization=authorization)

        async def command_result(self, tool, command_id, arguments, *, authorization):
            assert authorization == "Basic test-caller"
            assert tool == tool_name
            assert command_id == payload["commandID"]
            assert arguments == json.dumps(expected, separators=(",", ":"))
            return await super().command_result(
                tool, command_id, arguments, authorization=authorization
            )

    tools = _with_profile(
        WorkflowTools(
            tools=[_command_spec(tool_name)],
            receipt=ToolCallResult(json.dumps(receipt), False, receipt),
        )
    )
    llm = ScriptedFakeChatModel(
        responses=[
            AIMessage(content="", tool_calls=[{"name": tool_name, "args": payload, "id": "write"}]),
            AIMessage(content="Checked the result."),
        ]
    )
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    config = _config("workflow-payload")
    context = {
        "llm": llm,
        "tool_catalog": tools,
        "tool_executor": tools,
        "authorization": "Basic test-caller",
        "app_id": "cockpit",
        "max_steps": 8,
        "max_tool_calls": 16,
    }
    interrupted = await graph.ainvoke(
        {"messages": [HumanMessage(content="prepare")]}, config, context=context
    )
    assert interrupted["__interrupt__"]
    result = await graph.ainvoke(
        Command(resume={"approved_tool_call_ids": ["write"]}), config, context=context
    )
    assert result["outcomes"][0].status == "completed"
    assert tools.writes == 1


async def test_committed_cap_mcp_write_recovers_through_real_transport():
    url = os.environ.get("CAP_MCP_TEST_URL")
    if not url:
        pytest.skip("CAP MCP test server is not running")

    class LostResponseClient(McpToolClient):
        writes = 0
        receipts = 0

        async def call_tool(self, name, arguments, *, authorization):
            result = await super().call_tool(name, arguments, authorization=authorization)
            if name == "prepare_case_action":
                self.writes += 1
                assert result.is_error is False
                raise ConnectionError("response lost after CAP committed")
            return result

        async def command_result(self, tool, command_id, arguments, *, authorization):
            self.receipts += 1
            return await super().command_result(
                tool, command_id, arguments, authorization=authorization
            )

    client = LostResponseClient(
        url,
        app_id="cockpit",
        runtime_url=url.rsplit("/mcp/", 1)[0] + "/rest/assistant-runtime",
    )
    payload = json.loads(os.environ["CAP_MCP_TEST_PAYLOAD"])
    llm = ScriptedFakeChatModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[{"name": "prepare_case_action", "args": payload, "id": "write"}],
            ),
            AIMessage(content="Checked the result."),
        ]
    )
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    config = _config("cap-mcp-lost-response")
    context = {
        "llm": llm,
        "tool_catalog": client,
        "tool_executor": client,
        "authorization": os.environ["CAP_MCP_TEST_AUTH"],
        "app_id": "cockpit",
        "max_steps": 8,
        "max_tool_calls": 16,
    }
    interrupted = await graph.ainvoke(
        {"messages": [HumanMessage(content="prepare")]}, config, context=context
    )
    assert interrupted["__interrupt__"]
    result = await graph.ainvoke(
        Command(resume={"approved_tool_call_ids": ["write"]}), config, context=context
    )
    (outcome,) = result["outcomes"]
    assert outcome.success is True
    assert outcome.status == "completed"
    assert client.writes == 1
    assert client.receipts == 1
    assert outcome.call.args["commandID"] == payload["commandID"]


@pytest.mark.parametrize(
    ("registered", "read_only", "permitted"),
    [(False, True, True), (True, False, True), (True, True, False)],
)
async def test_conflict_recovery_cannot_expand_tool_scope(registered, read_only, permitted):
    conflict = ToolCallResult(
        "already prepared",
        True,
        error=ToolFailure(
            "CONFLICT", "already prepared", reconcile_tool="recover", reconcile_arguments={}
        ),
    )
    specs = [ToolSpec("list_feeds", "", {}, True)]
    if registered:
        specs.append(ToolSpec("recover", "", {}, read_only))
    tools = _with_profile(
        FakeToolClient(
            tools=specs,
            results={"list_feeds": conflict, "recover": ToolCallResult("{}", False, {})},
        )
    )
    if not permitted:
        tools._tools = [tool for tool in tools._tools if tool.name != "recover"]
    llm = ScriptedFakeChatModel(
        responses=[
            AIMessage(content="", tool_calls=[{"name": "list_feeds", "args": {}, "id": "read"}]),
            AIMessage(content="The conflict remains unresolved."),
        ]
    )
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="go")]},
        _config("recovery-scope"),
        context={
            "llm": llm,
            "tool_catalog": tools,
            "tool_executor": tools,
            "authorization": None,
            "max_steps": 8,
            "max_tool_calls": 16,
        },
    )
    assert [name for name, _ in tools.calls] == ["profile", "list_feeds"]
    assert result["outcomes"][0].error_code == "CONFLICT"
    assert result["outcomes"][0].success is False


@pytest.mark.parametrize(
    ("registered", "read_only", "permitted"),
    [(False, True, True), (True, False, True), (True, True, False)],
)
async def test_pending_polling_cannot_expand_tool_scope(registered, read_only, permitted):
    pending = {"ID": "run-1", "status": "pending"}
    specs = [ToolSpec("list_feeds", "", {}, True)]
    if registered:
        specs.append(ToolSpec("get_prediction_run", "", {}, read_only))
    tools = _with_profile(
        FakeToolClient(
            tools=specs,
            results={
                "list_feeds": ToolCallResult(json.dumps(pending), False, pending),
                "get_prediction_run": ToolCallResult(
                    "{}", False, {"ID": "run-1", "status": "succeeded"}
                ),
            },
        )
    )
    if not permitted:
        tools._tools = [tool for tool in tools._tools if tool.name != "get_prediction_run"]
    llm = ScriptedFakeChatModel(
        responses=[
            AIMessage(content="", tool_calls=[{"name": "list_feeds", "args": {}, "id": "read"}]),
            AIMessage(content="The run remains pending."),
        ]
    )
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="go")]},
        _config("polling-scope"),
        context={
            "llm": llm,
            "tool_catalog": tools,
            "tool_executor": tools,
            "authorization": None,
            "max_steps": 8,
            "max_tool_calls": 16,
        },
    )
    assert [name for name, _ in tools.calls] == ["profile", "list_feeds"]
    assert result["outcomes"][0].status == "pending"
    assert result["outcomes"][0].success is False


async def test_app_tool_isolation_rejects_foreign_calls_without_approval():
    tools = FakeToolClient(tools=[])
    llm = ScriptedFakeChatModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "start_lead_time_prediction",
                        "args": {"itemIDs": ["PO2-10"]},
                        "id": "foreign",
                    }
                ],
            ),
            AIMessage(content="unavailable"),
        ]
    )
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    context = {
        "llm": llm,
        "tool_catalog": tools,
        "tool_executor": tools,
        "authorization": None,
        "app_id": "cockpit",
        "max_steps": 8,
        "max_tool_calls": 16,
    }

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="start_prediction")]},
        _config("catalog-isolation"),
        context=context,
    )

    assert result["tools"] == []
    assert result["messages"][-1].content == "unavailable"
    assert any(
        getattr(message, "tool_call_id", None) == "foreign" and message.status == "error"
        for message in result["messages"]
    )


def test_offline_answer_finds_nested_links_and_caps_the_list():
    rows = [{"Customer": str(i), "link": f"#/Customers('{i}')"} for i in range(12)]
    answer = offline_answer(json.dumps({"result": {"items": rows}}))
    assert "Found 12" in answer
    assert "- [0](#/Customers('0'))" in answer
    assert "#/Customers('10')" not in answer
    assert "… and 2 more" in answer
    assert offline_answer("not json").endswith("not json")


def test_offline_answer_reads_toon_tables_from_cap_mcp():
    toon = (
        "action: listPriorities\n"
        "kind: function\n"
        "result[2]{priority,PurchaseOrder,PurchaseOrderItem,status,reason,link}:\n"
        '  1,"4500003276","90",overdue,"has passed, no GR",'
        "\"#/OpenItems(PurchaseOrder='4500003276',PurchaseOrderItem='90')\"\n"
        '  2,"4500002972","70",late,"say \\"hi\\"",'
        "\"#/OpenItems(PurchaseOrder='4500002972',PurchaseOrderItem='70')\"\n"
    )
    answer = offline_answer(toon)
    assert "Found 2" in answer
    assert (
        "- [PO 4500003276/90](#/OpenItems(PurchaseOrder='4500003276',PurchaseOrderItem='90'))"
        " — overdue"
    ) in answer
    assert "[PO 4500002972/70]" in answer
    assert "result[2]" not in answer
