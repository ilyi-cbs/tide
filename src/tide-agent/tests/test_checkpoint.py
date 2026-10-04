"""Every custom type the graph checkpoints must be allowlisted for msgpack.

Runs a turn that stops at an approval (so the interrupt payload and all
per-turn state are in the checkpoint) under LANGGRAPH_STRICT_MSGPACK, then
reads it back. A dataclass missing from ALLOWED_MSGPACK_MODULES fails here.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from textwrap import dedent

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from tests.test_graph import _command_spec

from agent.adapters.fakes import FakeToolClient, ScriptedFakeChatModel
from agent.adapters.sqlite_ckpt import open_sqlite_store
from agent.graph.build import build_graph
from agent.ports.tools import ToolCallResult, ToolSpec


@pytest.fixture(autouse=True)
def strict_msgpack(monkeypatch):
    monkeypatch.setenv("LANGGRAPH_STRICT_MSGPACK", "true")


async def test_checkpointed_types_are_allowlisted_and_hold_no_credentials(tmp_path):
    path = tmp_path / "c.sqlite"
    tool = ToolSpec(
        name="start_prediction", description="Predicts", input_schema={}, read_only=False
    )
    tools = FakeToolClient(tools=[tool])
    llm = ScriptedFakeChatModel(
        responses=[
            AIMessage(content="", tool_calls=[{"name": "start_prediction", "args": {}, "id": "c1"}])
        ]
    )
    context = {
        "llm": llm,
        "tool_catalog": tools,
        "tool_executor": tools,
        "authorization": "Basic c2VjcmV0LXRva2Vu",
        "app_id": "tabpfn-playground",
        "max_steps": 8,
        "max_tool_calls": 16,
    }
    config = {"configurable": {"thread_id": "t"}}
    async with open_sqlite_store(str(path)) as (saver, _):
        graph = build_graph(checkpointer=saver)
        await graph.ainvoke({"messages": [HumanMessage(content="go")]}, config, context=context)

    async with open_sqlite_store(str(path)) as (saver, _):
        state = await build_graph(checkpointer=saver).aget_state(config)
    assert state.interrupts, "expected a pending approval in the checkpoint"
    assert state.values["budget"].tool_calls_left == 16
    assert state.values["tools"] == [tool]

    raw = path.read_bytes()
    assert b"c2VjcmV0LXRva2Vu" not in raw
    assert b"secret-token" not in raw


@pytest.mark.parametrize("status", ["pending", "unknown"])
def test_process_exit_preserves_incomplete_tool_truth(tmp_path, status):
    path = tmp_path / "recovery.sqlite"
    worker = dedent("""
        import asyncio, json, os, sys
        from langchain_core.messages import AIMessage, HumanMessage
        from agent.adapters.fakes import FakeToolClient, ScriptedFakeChatModel
        from agent.adapters.sqlite_ckpt import open_sqlite_store
        from agent.graph.build import build_graph
        from agent.ports.tools import ToolCallResult, ToolFailure, ToolSpec

        async def main():
            path, mode, status = sys.argv[1:]
            config = {"configurable": {"thread_id": "recovery"}}
            async with open_sqlite_store(path) as (saver, _):
                graph = build_graph(checkpointer=saver)
                if mode == "write":
                    data = {"ID": "run-1", "status": "pending"}
                    result = (ToolCallResult(json.dumps(data), False, data)
                        if status == "pending" else ToolCallResult("connection lost", True,
                        error=ToolFailure("OUTCOME_UNKNOWN", "connection lost")))
                    tools = FakeToolClient(tools=[ToolSpec("lookup", "", {}, True)],
                        results={"lookup": result}, profile={"checked": True})
                    llm = ScriptedFakeChatModel(responses=[AIMessage(content="", tool_calls=[
                        {"name": "lookup", "args": {}, "id": "read"}]),
                        AIMessage(content="All done.")])
                    await graph.ainvoke({"messages": [HumanMessage(content="check")]}, config,
                        context={"llm": llm, "tool_catalog": tools, "tool_executor": tools,
                        "authorization": "Basic checkpoint-secret", "app_id": "cockpit",
                        "max_steps": 8, "max_tool_calls": 16})
                else:
                    state = await graph.aget_state(config)
                    print(json.dumps({"status": state.values["outcomes"][0].status,
                        "answer": state.values["messages"][-1].content,
                        "notes": state.values["verification_notes"]}))
            if mode == "write":
                os._exit(71)

        asyncio.run(main())
    """)
    project = Path(__file__).resolve().parents[1]
    lost = subprocess.run(
        [sys.executable, "-c", worker, str(path), "write", status],
        cwd=project,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert lost.returncode == 71, lost.stderr
    restored = subprocess.run(
        [sys.executable, "-c", worker, str(path), "read", status],
        cwd=project,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert restored.returncode == 0, restored.stderr
    result = json.loads(restored.stdout)
    assert result["status"] == status
    assert result["notes"]
    assert all(note in result["answer"] for note in result["notes"])
    assert b"checkpoint-secret" not in path.read_bytes()


async def test_write_intent_survives_restart_and_is_owner_scoped(tmp_path):
    from agent.adapters.sqlite_writes import open_write_journal
    from agent.graph.state import PendingToolCall
    from agent.ports.tools import ToolCallResult

    path = str(tmp_path / "writes.sqlite")
    call = PendingToolCall("w1", "prepare_case_action", {"commandID": "cmd-1", "caseID": "c1"})
    async with open_write_journal(path) as journal:
        assert await journal.begin("t1", "alice", "cockpit", call)
    async with open_write_journal(path) as journal:
        assert not await journal.begin("t1", "alice", "cockpit", call)
        assert not await journal.list_attempts("t1", "bob", "cockpit")
        assert not await journal.list_attempts("t1", "alice", "lead-time")
        attempts = await journal.list_attempts("t1", "alice", "cockpit")
        assert attempts[0].call == call
        assert attempts[0].result is None
        with pytest.raises(ValueError):
            await journal.begin("t1", "alice", "cockpit", PendingToolCall("w1", call.name, {}))
        await journal.finish("t1", "alice", "cockpit", call, ToolCallResult("receipt", False))
    async with open_write_journal(path) as journal:
        assert (await journal.list_attempts("t1", "alice", "cockpit"))[
            0
        ].result.content == "receipt"


@pytest.mark.parametrize("receipt_available", [True, False])
async def test_cancelled_write_recovers_after_restart_without_redispatch(
    tmp_path, receipt_available
):
    import asyncio

    from langchain_core.messages import AIMessage, ToolMessage
    from langgraph.types import Command
    from tests.test_turns import _context, _llm, assert_well_formed

    from agent.adapters.fakes import FakeToolClient
    from agent.adapters.sqlite_writes import open_write_journal
    from agent.graph.nodes import restore_write_messages
    from agent.ports.tools import ToolCallResult

    class CommittedWrite(FakeToolClient):
        async def call_tool(self, name, arguments, *, authorization):
            if name == "prepare_case_action":
                self.calls.append((name, arguments))
                await asyncio.Event().wait()
            return await super().call_tool(name, arguments, authorization=authorization)

    path = str(tmp_path / "cancelled.sqlite")
    specs = [_command_spec("prepare_case_action")]
    config = {"configurable": {"thread_id": "cancelled"}}
    tools = CommittedWrite(tools=specs)
    llm = _llm(
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "prepare_case_action",
                    "args": {"caseID": "case-1"},
                    "id": "w1",
                }
            ],
        )
    )
    async with open_sqlite_store(path) as (saver, _), open_write_journal(path) as journal:
        graph = build_graph(checkpointer=saver)
        context = _context(
            llm, tools, write_attempts=journal, thread_id="cancelled", user_id="alice"
        )
        await graph.ainvoke(
            {"messages": [HumanMessage(content="prepare")]}, config, context=context
        )
        with pytest.raises(TimeoutError):
            async with asyncio.timeout(0.1):
                await graph.ainvoke(
                    Command(resume={"approved_tool_call_ids": ["w1"]}), config, context=context
                )
        assert len([name for name, _ in tools.calls if name == "prepare_case_action"]) == 1
        attempts = await journal.list_attempts("cancelled", "alice", "tabpfn-playground")
        command_id = attempts[0].call.args["commandID"]
        snapshot = await graph.aget_state(config)
        restored = restore_write_messages(snapshot.values["messages"], attempts, 20_000)
        assert "unknown" in str(restored[-1].content)

    receipt = (
        {
            "commandID": command_id,
            "caseID": "case-1",
            "actionID": "action-1",
            "payloadMatched": True,
        }
        if receipt_available
        else None
    )
    tools = FakeToolClient(
        tools=specs,
        receipt=ToolCallResult("{}", False, receipt),
    )
    async with open_sqlite_store(path) as (saver, _), open_write_journal(path) as journal:
        graph = build_graph(checkpointer=saver)
        context = _context(
            _llm(AIMessage(content="All done.")),
            tools,
            write_attempts=journal,
            thread_id="cancelled",
            user_id="alice",
        )
        result = await graph.ainvoke(
            {"messages": [HumanMessage(content="what happened?")]}, config, context=context
        )
        assert not any(name == "prepare_case_action" for name, _ in tools.calls)
        assert_well_formed(result["messages"])
        if receipt_available:
            assert not result["outcomes"]
            assert any(
                isinstance(message, ToolMessage) and message.status == "success"
                for message in result["messages"]
            )
        else:
            assert result["outcomes"][0].status == "unknown"
            assert "outcome unknown" in result["messages"][-1].content
            assert all(tool.read_only for tool in result["tools"])


@pytest.mark.parametrize("legacy", [False, True])
async def test_process_dies_after_dispatch_without_replaying_write(tmp_path, legacy):
    import asyncio

    from tests.test_turns import _context, _llm

    from agent.adapters.sqlite_writes import open_write_journal

    path = str(tmp_path / "dispatch.sqlite")
    receipt_path = tmp_path / "receipt.json"
    worker = dedent("""
        import asyncio, json, os, sys
        from pathlib import Path
        from langchain_core.messages import AIMessage, HumanMessage
        from langgraph.types import Command
        from agent.adapters.fakes import FakeToolClient
        from agent.adapters.sqlite_ckpt import open_sqlite_store
        from agent.adapters.sqlite_writes import open_write_journal
        from agent.graph.build import build_graph
        from tests.test_graph import _command_spec
        from tests.test_turns import _context, _llm

        class CommitThenExit(FakeToolClient):
            async def call_tool(self, name, arguments, *, authorization):
                if name == "prepare_case_action":
                    Path(sys.argv[2]).write_text(json.dumps({
                        "commandID": arguments["commandID"],
                        "caseID": "case-1",
                        "actionID": "action-1", "payloadMatched": True}))
                    os._exit(71)
                return await super().call_tool(name, arguments, authorization=authorization)

        async def main():
            specs = [_command_spec("prepare_case_action")]
            tools = CommitThenExit(tools=specs)
            llm = _llm(AIMessage(content="", tool_calls=[{
                "name": "prepare_case_action", "args": {"caseID": "case-1"}, "id": "w1"}]))
            async with (
                open_sqlite_store(sys.argv[1]) as (saver, _),
                open_write_journal(sys.argv[1]) as journal,
            ):
                context = _context(llm, tools,
                    write_attempts=None if sys.argv[3] == "True" else journal,
                    thread_id="dispatch", user_id="alice")
                graph = build_graph(checkpointer=saver)
                config = {"configurable": {"thread_id": "dispatch"}}
                await graph.ainvoke({"messages": [HumanMessage(content="prepare")]},
                                    config, context=context)
                await graph.ainvoke(Command(resume={"approved_tool_call_ids": ["w1"]}),
                                    config, context=context)

        asyncio.run(main())
    """)
    project = await asyncio.to_thread(lambda: Path(__file__).resolve().parents[1])
    lost = await asyncio.to_thread(
        subprocess.run,
        [sys.executable, "-c", worker, path, str(receipt_path), str(legacy)],
        cwd=project,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert lost.returncode == 71, lost.stderr
    receipt = json.loads(await asyncio.to_thread(receipt_path.read_text))
    specs = [_command_spec("prepare_case_action")]
    tools = FakeToolClient(
        tools=specs,
        receipt=ToolCallResult(json.dumps(receipt), False, receipt),
    )
    async with open_sqlite_store(path) as (saver, _), open_write_journal(path) as journal:
        context = _context(
            _llm(AIMessage(content="Recovered.")),
            tools,
            write_attempts=journal,
            thread_id="dispatch",
            user_id="alice",
        )
        result = await build_graph(checkpointer=saver).ainvoke(
            {"messages": [HumanMessage(content="status?")]},
            {"configurable": {"thread_id": "dispatch"}},
            context=context,
        )
        assert not any(name == "prepare_case_action" for name, _ in tools.calls)
        assert not result["outcomes"]
        assert len(await journal.list_attempts("dispatch", "alice", "tabpfn-playground")) == 1
    assert b"Basic " not in await asyncio.to_thread(Path(path).read_bytes)
