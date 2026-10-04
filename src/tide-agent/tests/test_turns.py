"""Regression tests for turn invariants (Phase 1 of findings.md):
Regression coverage for turn budgets, history, approvals, and tool-result invariants."""

from __future__ import annotations

import asyncio
import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from agent.adapters.fakes import FakeToolClient, ScriptedFakeChatModel
from agent.adapters.sqlite_ckpt import serializer
from agent.graph.build import build_graph
from agent.graph.nodes import BUDGET_EXHAUSTED_TEXT, DANGLING_CALL_TEXT, OVER_BUDGET_TEXT
from agent.policy.trim import fit_prompt, prompt_cost, trim_history
from agent.ports.tools import ToolCallResult, ToolFailure, ToolSpec

READ = ToolSpec(name="list_feeds", description="Lists feeds", input_schema={}, read_only=True)
WRITE = ToolSpec(name="start_prediction", description="Predicts", input_schema={}, read_only=False)


class RecordingLLM(ScriptedFakeChatModel):
    """Scripted, and remembers every prompt it was sent."""

    prompts: list = []

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        self.prompts.append(list(messages))
        async for chunk in super()._astream(messages, stop, run_manager, **kwargs):
            yield chunk

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.prompts.append(list(messages))
        return super()._generate(messages, stop, run_manager, **kwargs)


def _llm(*responses: AIMessage) -> RecordingLLM:
    return RecordingLLM(responses=list(responses), prompts=[])


def _call(*ids: str, name: str = "list_feeds") -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": {}, "id": i} for i in ids])


def _context(llm, tools=None, **overrides) -> dict:
    tools = tools or FakeToolClient(
        tools=[READ, WRITE], results={"list_feeds": ToolCallResult("[]", False)}
    )
    return {
        "llm": llm,
        "tool_catalog": tools,
        "tool_executor": tools,
        "authorization": None,
        "app_id": "tabpfn-playground",
        "max_steps": 8,
        "max_tool_calls": 16,
        **overrides,
    }


def _graph():
    return build_graph(checkpointer=InMemorySaver(serde=serializer()))


def _config(thread: str) -> dict:
    return {"configurable": {"thread_id": thread}}


async def _turn(graph, thread: str, text: str, context: dict) -> dict:
    return await graph.ainvoke(
        {"messages": [HumanMessage(content=text)]}, _config(thread), context=context
    )


def assert_well_formed(messages) -> None:
    """Every tool call has exactly one result and every result has a call."""
    calls = [tc["id"] for m in messages if isinstance(m, AIMessage) for tc in m.tool_calls]
    results = [m.tool_call_id for m in messages if isinstance(m, ToolMessage)]
    assert sorted(calls) == sorted(results), (calls, results)
    assert len(set(calls)) == len(calls)
    assert not any(isinstance(m, SystemMessage) for m in messages)


# ------------------------------------------------------------ per-turn state


async def test_budget_is_fresh_every_turn():
    graph = _graph()
    for turn in range(3):
        # each turn uses 2 of 3 steps; a carried-over budget would starve turn 2
        llm = _llm(_call(f"c{turn}"), AIMessage(content=f"answer {turn}"))
        result = await _turn(graph, "budget", f"q{turn}", _context(llm, max_steps=3))
        assert result["messages"][-1].content == f"answer {turn}"
        assert result["budget"].steps_left == 1


async def test_client_cannot_send_its_own_budget():
    graph = _graph()
    llm = _llm(AIMessage(content="ok"))
    await graph.ainvoke(
        {
            "messages": [HumanMessage(content="hi")],
            "budget": {"steps_left": 999, "tool_calls_left": 999},
        },
        _config("forged"),
        context=_context(llm, max_steps=2),
    )
    state = await graph.aget_state(_config("forged"))
    assert state.values["budget"].steps_left == 1


# ------------------------------------------------------------ system prompt


async def test_system_prompt_is_sent_but_never_stored():
    graph = _graph()
    for turn in range(2):
        llm = _llm(AIMessage(content="ok"))
        result = await _turn(graph, "sys", f"q{turn}", _context(llm))
        (prompt,) = llm.prompts
        assert isinstance(prompt[0], SystemMessage)
        assert sum(isinstance(m, SystemMessage) for m in prompt) == 1
        assert not any(isinstance(m, SystemMessage) for m in result["messages"])


async def test_system_prompt_stored_by_older_versions_is_removed():
    graph = _graph()
    config = _config("legacy")
    await graph.aupdate_state(
        config,
        {"messages": [SystemMessage(content="old prompt", id="s1"), HumanMessage("hi", id="h1")]},
        as_node="finalize",
    )
    llm = _llm(AIMessage(content="ok"))
    result = await _turn(graph, "legacy", "again", _context(llm))
    assert not any(isinstance(m, SystemMessage) for m in result["messages"])
    assert "old prompt" not in str(llm.prompts[0])


# ------------------------------------------------------------ trimming


def test_trim_drops_whole_exchanges_from_the_front():
    history = []
    for i in range(5):
        history += [
            HumanMessage(content="question " * 50, id=f"h{i}"),
            AIMessage(
                content="", tool_calls=[{"name": "t", "args": {}, "id": f"c{i}"}], id=f"a{i}"
            ),
            ToolMessage(content="result " * 50, tool_call_id=f"c{i}", id=f"t{i}"),
            AIMessage(content="answer", id=f"f{i}"),
        ]
    dropped = trim_history(history, max_tokens=300)
    kept = history[len(dropped) :]
    assert dropped and kept
    assert isinstance(kept[0], HumanMessage)
    assert_well_formed(kept)


def test_trim_keeps_the_newest_exchange_even_if_too_long():
    history = [
        HumanMessage("old", id="h0"),
        AIMessage("a", id="a0"),
        HumanMessage("x" * 10_000, id="h1"),
    ]
    assert [m.id for m in trim_history(history, max_tokens=10)] == ["h0", "a0"]


def test_trim_is_a_noop_under_budget():
    assert trim_history([HumanMessage("hi"), AIMessage("hello")], max_tokens=1000) == []


async def test_trimming_shrinks_the_stored_thread():
    graph = _graph()
    for _ in range(6):
        llm = _llm(AIMessage(content="answer " * 100))
        result = await _turn(
            graph, "long", "question " * 100, _context(llm, max_history_tokens=400)
        )
    stored = result["messages"]
    assert len(stored) < 12
    assert isinstance(stored[0], HumanMessage)
    assert_well_formed(stored)


# ------------------------------------------------------------ budget end


async def test_tool_budget_exhausted_ends_with_a_final_answer_without_tools():
    llm = _llm(_call("c1"), AIMessage(content="final from what I have"))
    result = await _turn(
        _graph(),
        "final",
        "go",
        _context(llm, max_tool_calls=1),
    )
    assert result["messages"][-1].content == "final from what I have"
    assert_well_formed(result["messages"])
    final_prompt = llm.prompts[-1]
    assert "budget for this turn is used up" in final_prompt[-1].content


async def test_step_budget_exhausted_ends_with_the_fixed_message():
    llm = _llm(_call("c1"), _call("c2"))
    result = await _turn(
        _graph(),
        "steps",
        "go",
        _context(llm, max_steps=2),
    )
    assert result["messages"][-1].content == BUDGET_EXHAUSTED_TEXT
    assert_well_formed(result["messages"])


async def test_model_that_insists_on_tools_still_gets_a_closing_answer():
    llm = _llm(_call("c1"), _call("c2"), _call("c3"))
    result = await _turn(
        _graph(),
        "insist",
        "go",
        _context(llm, max_tool_calls=1),
    )
    last = result["messages"][-1]
    assert isinstance(last, AIMessage) and not last.tool_calls
    assert_well_formed(result["messages"])


# ------------------------------------------------------------ fan-out


async def test_tool_calls_beyond_the_budget_are_answered_not_run():
    ran: list[str] = []

    class Counting(FakeToolClient):
        async def call_tool(self, name, arguments, *, authorization):
            ran.append(name)
            return ToolCallResult("[]", False)

    llm = _llm(_call(*[f"c{i}" for i in range(5)]), AIMessage(content="done"))
    tools = Counting(tools=[READ])
    result = await _turn(
        _graph(),
        "fanout",
        "go",
        _context(llm, tools, max_tool_calls=2),
    )
    assert len(ran) == 2
    over = [
        m
        for m in result["messages"]
        if isinstance(m, ToolMessage) and m.content == OVER_BUDGET_TEXT
    ]
    assert len(over) == 3
    assert_well_formed(result["messages"])


async def test_tool_calls_execute_one_step_at_a_time():
    running = 0
    peak = 0

    class Slow(FakeToolClient):
        async def call_tool(self, name, arguments, *, authorization):
            nonlocal running, peak
            running += 1
            peak = max(peak, running)
            await asyncio.sleep(0.01)
            running -= 1
            return ToolCallResult("[]", False)

    llm = _llm(_call(*[f"c{i}" for i in range(10)]), AIMessage(content="done"))
    await _turn(
        _graph(),
        "parallel",
        "go",
        _context(llm, Slow(tools=[READ]), max_parallel_read_only_calls=3),
    )
    assert peak == 1


async def test_large_tool_results_are_truncated_with_a_note():
    tools = FakeToolClient(tools=[READ], results={"list_feeds": ToolCallResult("x" * 500, False)})
    llm = _llm(_call("c1"), AIMessage(content="done"))
    result = await _turn(
        _graph(),
        "big",
        "go",
        _context(llm, tools, max_tool_result_chars=100),
    )
    (tool_result,) = [m for m in result["messages"] if isinstance(m, ToolMessage)]
    assert tool_result.content.startswith("x" * 100)
    assert "[truncated: 400 of 500 characters not shown]" in tool_result.content


@pytest.mark.parametrize(
    ("run_status", "outcome_status", "success"),
    [
        ("succeeded", "completed", True),
        ("pending", "pending", False),
        ("running", "pending", False),
        ("failed", "failed", False),
    ],
)
async def test_prediction_outcome_survives_prompt_truncation(run_status, outcome_status, success):
    data = {"ID": "run-1", "status": run_status, "payload": "x" * 500}
    response = ToolCallResult(json.dumps(data), False, data)
    tools = FakeToolClient(
        tools=[
            ToolSpec("start_prediction", "", {}, True),
            ToolSpec("get_prediction_run", "", {}, True),
        ],
        results={"start_prediction": response, "get_prediction_run": response},
    )
    llm = _llm(_call("p1", name="start_prediction"), AIMessage(content="Result received."))
    result = await _turn(
        _graph(),
        "structured-outcome",
        "start_prediction",
        _context(llm, tools, max_tool_result_chars=100),
    )
    (outcome,) = result["outcomes"]
    assert outcome.data == {"ID": "run-1", "status": run_status}
    assert outcome.status == outcome_status
    assert outcome.success is success
    (tool_result,) = [message for message in result["messages"] if isinstance(message, ToolMessage)]
    assert "[truncated:" in tool_result.content
    assert "verification_notes" in result
    if not success:
        assert result["verification_notes"]
        assert "run-1" in str(llm.prompts[-1])
    assert_well_formed(result["messages"])


@pytest.mark.parametrize("code", ["OUTCOME_UNKNOWN", "UPSTREAM_OUTCOME_UNKNOWN"])
async def test_unknown_outcome_error_metadata_survives_prompt_truncation(code):
    tools = FakeToolClient(
        tools=[READ],
        results={
            "list_feeds": ToolCallResult(
                "display text",
                True,
                error=ToolFailure(code, "x" * 500, reference="correlation-1"),
            )
        },
    )
    llm = _llm(_call("u1"), AIMessage(content="The outcome is unknown."))
    result = await _turn(
        _graph(), "unknown-outcome", "go", _context(llm, tools, max_tool_result_chars=100)
    )
    (outcome,) = result["outcomes"]
    assert outcome.success is False
    assert outcome.status == "unknown"
    assert outcome.error_code == code
    assert outcome.retryable is False
    assert outcome.reference == "correlation-1"
    assert_well_formed(result["messages"])


# ------------------------------------------------------------ approvals


async def test_pending_outcome_survives_a_later_successful_batch():
    data = {"ID": "run-1", "status": "pending"}
    tools = FakeToolClient(
        tools=[READ, ToolSpec("start_prediction", "", {}, True)],
        results={
            "start_prediction": ToolCallResult(json.dumps(data), False, data),
            "list_feeds": ToolCallResult("[]", False),
        },
    )
    result = await _turn(
        _graph(),
        "pending-then-read",
        "go",
        _context(
            _llm(
                _call("p1", name="start_prediction"),
                _call("r1"),
                AIMessage(content="Everything completed successfully."),
            ),
            tools,
        ),
    )
    assert [outcome.status for outcome in result["outcomes"]] == ["pending", "completed"]
    assert "outcome pending" in result["messages"][-1].content


async def test_oversized_complete_prompt_never_calls_the_model():
    llm = _llm(AIMessage(content="should not run"))
    result = await _turn(
        _graph(), "oversized-prompt", "x" * 5000, _context(llm, max_prompt_tokens=1000)
    )
    assert not llm.prompts
    assert "context limit" in result["messages"][-1].content


def test_prompt_compaction_preserves_pairs_and_outcome_evidence():
    messages = [
        SystemMessage(content="Never hide outcome unknown."),
        HumanMessage(content="go"),
        _call("c1"),
        ToolMessage(
            content=json.dumps({"ID": "run-1", "status": "pending", "payload": "x" * 5000}),
            tool_call_id="c1",
        ),
    ]
    fitted = fit_prompt(messages, [], 1000)
    assert fitted is not None
    assert prompt_cost(fitted, []) <= 1000
    assert "run-1" in str(fitted[-1].content)
    assert "pending" in str(fitted[-1].content)
    assert len(fitted) == len(messages)


def test_tool_schemas_are_part_of_the_prompt_budget():
    assert fit_prompt([HumanMessage(content="hi")], [{"description": "x" * 5000}], 1000) is None


@pytest.mark.parametrize("content", ["{}", "not a receipt", '{"status":"succeeded"}'])
async def test_prediction_without_run_evidence_is_unknown(content):
    tools = FakeToolClient(
        tools=[ToolSpec("start_prediction", "", {}, True)],
        results={"start_prediction": ToolCallResult(content, False)},
    )
    result = await _turn(
        _graph(),
        "missing-receipt",
        "go",
        _context(
            _llm(_call("p1", name="start_prediction"), AIMessage(content="All done.")),
            tools,
        ),
    )
    assert result["outcomes"][0].status == "unknown"
    assert "outcome unknown" in result["messages"][-1].content


async def test_approval_across_turns_keeps_the_history_well_formed():
    graph = _graph()
    config = _config("multi")
    llm = _llm(_call("w1", name="start_prediction"), AIMessage(content="predicted"))
    context = _context(llm)
    await _turn(graph, "multi", "start_prediction", context)
    await graph.ainvoke(Command(resume={"approved_tool_call_ids": ["w1"]}), config, context=context)

    llm2 = _llm(_call("w2", name="start_prediction"), AIMessage(content="not done"))
    context2 = _context(llm2)
    await _turn(graph, "multi", "again", context2)
    result = await graph.ainvoke(
        Command(resume={"approved_tool_call_ids": []}), config, context=context2
    )
    assert result["messages"][-1].content == "not done"
    assert_well_formed(result["messages"])


async def test_new_input_during_a_pending_approval_answers_the_dangling_call():
    """The API rejects this with 409; the graph must still stay consistent
    if it happens anyway (e.g. an older client)."""
    graph = _graph()
    llm = _llm(_call("w1", name="start_prediction"))
    interrupted = await _turn(graph, "dangling", "start_prediction", _context(llm))
    assert "__interrupt__" in interrupted

    llm2 = _llm(AIMessage(content="moving on"))
    result = await _turn(graph, "dangling", "never mind, something else", _context(llm2))
    dangling = [
        m for m in result["messages"] if isinstance(m, ToolMessage) and m.tool_call_id == "w1"
    ]
    assert [m.content for m in dangling] == [DANGLING_CALL_TEXT]
    prompt = llm2.prompts[0]
    call_index = next(
        index
        for index, message in enumerate(prompt)
        if isinstance(message, AIMessage) and message.tool_calls
    )
    assert isinstance(prompt[call_index + 1], ToolMessage)
    assert result["messages"][-1].content == "moving on"
    assert_well_formed(result["messages"])


# ------------------------------------------------------------ invariant


SCENARIOS = [
    ("plain", [AIMessage(content="hi")], {}),
    ("read", [_call("r1"), AIMessage(content="done")], {}),
    ("unknown", [_call("u1", name="dropTables"), AIMessage(content="no")], {}),
    ("fanout", [_call("a", "b", "c"), AIMessage(content="done")], {"max_tool_calls": 1}),
    ("steps", [_call("s1"), _call("s2"), _call("s3")], {"max_steps": 2}),
    ("tools", [_call("t1"), _call("t2")], {"max_tool_calls": 1}),
    ("write", [_call("w1", name="start_prediction")], {}),
    (
        "mixed",
        [
            _call("r1", "r2"),
            AIMessage(
                content="",
                tool_calls=[
                    {"name": "list_feeds", "args": {}, "id": "m1"},
                    {"name": "start_prediction", "args": {}, "id": "m2"},
                ],
            ),
            AIMessage(content="done"),
        ],
        {},
    ),
]


@pytest.mark.parametrize(("name", "script", "limits"), SCENARIOS, ids=[s[0] for s in SCENARIOS])
@pytest.mark.parametrize("decision", [["w1", "m2"], []], ids=["approve", "decline"])
async def test_no_scenario_leaves_an_unanswered_tool_call(name, script, limits, decision):
    graph = _graph()
    config = _config(f"inv-{name}")
    context = _context(_llm(*script), **limits)
    result = await _turn(graph, f"inv-{name}", "go", context)
    while "__interrupt__" in result:
        result = await graph.ainvoke(
            Command(resume={"approved_tool_call_ids": decision}), config, context=context
        )
    # and one more turn on the same thread
    result = await _turn(graph, f"inv-{name}", "next", _context(_llm(AIMessage(content="bye"))))
    assert result["messages"][-1].content == "bye"
    assert_well_formed(result["messages"])
