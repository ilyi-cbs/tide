"""Cockpit chat (P-9): tools and instructions from CAP per turn, stripped tool
results, end-of-turn checks. Scripted fake LLM, in-memory tools."""

from __future__ import annotations

import json
from pathlib import Path

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from agent.adapters.fakes import FakeToolClient, OfflineChatModel, ScriptedFakeChatModel
from agent.adapters.sqlite_ckpt import serializer
from agent.graph.build import build_graph
from agent.graph.nodes import NO_PROFILE_TEXT, SYSTEM_PROMPT
from agent.policy.checks import ToolOutcome, TurnRules, check_turn
from agent.policy.strip import split_card
from agent.ports.tools import ToolCallResult, ToolSpec

# The end-of-turn rules as CAP's runtime profile serves them.
CHECKS = json.loads((Path(__file__).parent / "fixtures" / "cockpit_turn_checks.json").read_text())
NO_ACTION = CHECKS["noAction"]
RULES = TurnRules.from_cap(CHECKS)

READ = [
    "get_today",
    "list_cases",
    "get_case",
    "list_cases",
    "list_priorities",
]
WRITE = ["prepare_case_action", "start_prediction"]
PROFILE = {
    "actionTools": ["prepare_case_action"],
    "checks": json.dumps(CHECKS),
}


def _specs(extra: list[str] | None = None) -> list[ToolSpec]:
    return [
        ToolSpec(name=n, description=n, input_schema={}, read_only=True)
        for n in [*READ, *(extra or [])]
    ] + [
        ToolSpec(
            name=name,
            description=name,
            input_schema={
                "type": "object",
                "required": ["commandID", "caseID", "expectedFingerprint"],
                "properties": {
                    key: {"type": "string"}
                    for key in ["commandID", "caseID", "expectedFingerprint"]
                },
            }
            if name == "prepare_case_action"
            else {},
            read_only=False,
        )
        for name in WRITE
    ]


def _tools(
    results: dict[str, ToolCallResult],
    profile: dict | Exception = PROFILE,
    *,
    context: dict | Exception | None = None,
) -> FakeToolClient:
    return FakeToolClient(
        tools=_specs(),
        results=results,
        instructions="COCKPIT RULES: numbers only from tools.",
        profile=profile,
        context=context,
    )


class RecordingLLM(ScriptedFakeChatModel):
    prompts: list = []

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.prompts.append(messages)
        return super()._generate(messages, stop, run_manager, **kwargs)


def _context(llm, tools) -> dict:
    return {
        "llm": llm,
        "tool_catalog": tools,
        "tool_executor": tools,
        "authorization": "Basic x",
        "app_id": "cockpit",
        "max_steps": 8,
        "max_tool_calls": 16,
    }


def _config(thread: str) -> dict:
    return {"configurable": {"thread_id": thread}}


def _call(name: str, args: dict | None = None, id: str = "c1") -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args or {}, "id": id}])


# ------------------------------------------------------------------ profile


async def test_cockpit_tools_and_instructions_come_from_cap_per_turn():
    llm = RecordingLLM(responses=[AIMessage(content="Nothing to report.")])
    llm.prompts = []
    tools = _tools({})
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="hi")]}, _config("p1"), context=_context(llm, tools)
    )

    assert tools.calls == [("profile", {})]
    assert sorted(t.name for t in result["tools"]) == sorted([*READ, *WRITE])
    assert result["profile"]["action_tools"] == ["prepare_case_action"]
    system = llm.prompts[0][0]
    assert isinstance(system, SystemMessage)
    assert system.content.startswith(SYSTEM_PROMPT)
    assert "TIDE, the buyer's purchasing desk" in SYSTEM_PROMPT
    assert "Hey! What would you like to check in TIDE, your purchasing desk?" in SYSTEM_PROMPT
    assert "Do not use that greeting as the answer to a substantive question" in SYSTEM_PROMPT
    assert "COCKPIT RULES" in system.content
    # The system prompt is never stored.
    assert not any(isinstance(m, SystemMessage) for m in result["messages"])


async def test_current_page_context_is_added_to_the_ephemeral_prompt_only():
    llm = RecordingLLM(responses=[AIMessage(content="Verified case.")], prompts=[])
    tools = _tools(
        {},
        context={
            "valid": True,
            "profile": "delivery-risk-detail",
            "canonicalContext": json.dumps(
                {
                    "surface": "cockpit.delivery-risk-detail",
                    "entity": {"kind": "case", "id": "delivery:1/10"},
                }
            ),
            "instructions": "Read the current case first.",
        },
    )
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    context = {
        **_context(llm, tools),
        "page_context": {
            "version": 1,
            "app": "cockpit",
            "surface": "cockpit.delivery-risk-detail",
            "entity": {"kind": "case", "id": "delivery:1/10"},
        },
        "page_context_resolution": {},
    }

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="Why is this case listed?")]},
        _config("context-ephemeral"),
        context=context,
    )

    prompt = llm.prompts[0]
    assert any(
        isinstance(message, SystemMessage) and "Read the current case first" in message.content
        for message in prompt
    )
    assert any(
        isinstance(message, SystemMessage) and "delivery:1/10" in message.content
        for message in prompt
    )
    assert all(not isinstance(message, SystemMessage) for message in result["messages"])
    assert "delivery:1/10" not in " ".join(str(message.content) for message in result["messages"])


async def test_page_context_is_advisory_and_never_narrows_app_catalog():
    llm = RecordingLLM(responses=[AIMessage(content="done")], prompts=[])
    tools = _tools(
        {},
        context={
            "valid": True,
            "profile": "narrow",
            "allowedTools": ["list_cases", "not-in-catalog"],
        },
    )
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    context = {
        **_context(llm, tools),
        "page_context": {"version": 1, "app": "cockpit", "surface": "cockpit.overview"},
        "page_context_resolution": {},
    }
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="summarize")]},
        _config("context-narrowing"),
        context=context,
    )
    assert {tool.name for tool in result["tools"]} == set([*READ, *WRITE])
    assert "allowedTools" not in context["page_context_resolution"]


async def test_cockpit_fails_closed_without_initialize_instructions_or_runtime_profile():
    llm = RecordingLLM(responses=[AIMessage(content="I cannot look this up now.")])
    llm.prompts = []
    for tools in (
        FakeToolClient(tools=[ToolSpec("get_today", "", {}, True)], instructions=""),
        _tools({}, profile=ConnectionError("profile unavailable")),
    ):
        graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
        result = await graph.ainvoke(
            {"messages": [HumanMessage(content="hi")]},
            _config("closed"),
            context=_context(llm, tools),
        )
        assert result["tools"] == []
        assert NO_PROFILE_TEXT in llm.prompts[-1][0].content


async def test_cockpit_rejects_a_tool_outside_the_app_catalog():
    llm = ScriptedFakeChatModel(responses=[_call("list_feeds"), AIMessage(content="ok")])
    tools = _tools({})
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="feeds")]}, _config("p3"), context=_context(llm, tools)
    )
    tool_msg = next(m for m in result["messages"] if getattr(m, "tool_call_id", None) == "c1")
    assert tool_msg.status == "error"
    assert [c for c, _ in tools.calls] == ["profile"]


async def test_cap_profiles_limit_each_app_to_its_own_catalog_tools():
    profiles = {
        "lead-time": ["list_open_po_items", "start_lead_time_prediction", "get_prediction_run"],
        "tabpfn-playground": [
            "list_feeds",
            "describe_feed",
            "get_prediction_run",
            "start_prediction",
        ],
    }
    for app_id, names in profiles.items():
        tools = FakeToolClient(
            tools=[
                ToolSpec(
                    name,
                    name,
                    {},
                    name
                    in {"list_open_po_items", "get_prediction_run", "list_feeds", "describe_feed"},
                )
                for name in names
            ],
        )
        llm = RecordingLLM(responses=[AIMessage(content="done")], prompts=[])
        graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
        result = await graph.ainvoke(
            {"messages": [HumanMessage(content="hi")]},
            _config(app_id),
            context={**_context(llm, tools), "app_id": app_id},
        )
        assert {tool.name for tool in result["tools"]} == set(names)
        assert tools.calls == [("profile", {})]


# ------------------------------------------------------------------ cards


def test_card_goes_to_the_ui_not_to_the_model():
    data = {"verdict": "pass", "card": json.dumps({"kind": "prediction", "rows": [1, 2]})}
    rest, card = split_card(data)
    assert card == {"kind": "prediction", "rows": [1, 2]}
    assert rest == {"verdict": "pass"}
    assert split_card({"verdict": "pass"}) == ({"verdict": "pass"}, None)


async def test_tool_results_reach_the_model_as_cap_sent_them_without_the_card():
    data = {
        "realityCheck": "Reality check: had I asked this 8 weeks ago, 7 of my top 10 would have "
        "been late (normally 3 of 10)",
        "verdict": "pass",
        "rows": [{"rank": 1, "PurchaseOrder": "4500000001"}],
        "card": {"kind": "prediction", "id": "q1"},
    }
    llm = ScriptedFakeChatModel(responses=[_call("list_priorities"), AIMessage(content="done")])
    tools = _tools({"list_priorities": ToolCallResult(json.dumps(data), False, data)})
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="p")]}, _config("s1"), context=_context(llm, tools)
    )
    tool_msg = next(m for m in result["messages"] if getattr(m, "tool_call_id", None) == "c1")
    seen = json.loads(tool_msg.content)
    assert seen["rows"] == [{"rank": 1, "PurchaseOrder": "4500000001"}]
    assert "card" not in seen
    assert tool_msg.artifact == {"card": {"kind": "prediction", "id": "q1"}}


# ------------------------------------------------------------------ end-of-turn checks


def test_action_claim_without_a_prepared_action_gets_a_note():
    claimed = check_turn("I prepared a reminder for PO 4500000001.", [], RULES)
    assert claimed.notes == [NO_ACTION]
    ok = check_turn(
        "The reminder draft is prepared.",
        [ToolOutcome("prepare_case_action", '{"ID":"a1"}', False, prepared_action=True)],
        RULES,
    )
    assert ok.notes == []
    negated = check_turn("No action was prepared; I cannot send reminders.", [], RULES)
    assert negated.notes == []
    failed = check_turn(
        "The reminder is ready.",
        [ToolOutcome("prepare_case_action", "Error calling prepare_case_action: 409", True, True)],
        RULES,
    )
    assert NO_ACTION in failed.notes


def test_unquoted_errors_and_warnings_are_appended_except_expert_ones():
    outcomes = [
        ToolOutcome("list_cases", "Error calling list_cases: unknown supplier 9999", True),
        ToolOutcome(
            "get_lead_time_range",
            json.dumps(
                {
                    "warnings": [
                        "no source for material M1 in plant 1010",
                        "TabPFN context widened to 120 context rows",
                        "p90 is not calibrated",
                    ]
                }
            ),
            False,
        ),
    ]
    result = check_turn("Here is the range.", outcomes, RULES)
    assert result.notes == [
        "- unknown supplier 9999\n- no source for material M1 in plant 1010",
    ]
    quoted = check_turn(
        "unknown supplier 9999. No source for material M1 in plant 1010.", outcomes, RULES
    )
    assert quoted.notes == []


def test_prediction_check_and_refusal_must_be_quoted():
    reality = (
        "Reality check: had I asked this 8 weeks ago, 3 of my top 10 would have been late "
        "(normally 3 of 10)"
    )
    refusal = "I can't predict this reliably: on the last 8 weeks my ranking was not clearly"
    out = ToolOutcome(
        "start_prediction",
        json.dumps({"realityCheck": reality, "verdict": "fail", "answer": refusal}),
        False,
    )
    assert check_turn(f"{reality}. {refusal}", [out], RULES).notes == []
    assert check_turn("It did not work.", [out], RULES).notes == [f"- {reality}\n- {refusal}"]
    # Without rules from CAP the agent appends nothing (it invents no texts).
    assert check_turn("I prepared a reminder.", [out], TurnRules()).notes == []


async def test_check_node_appends_notes_to_the_final_answer():
    llm = ScriptedFakeChatModel(
        responses=[_call("list_cases"), AIMessage(content="I created a reminder for you.")]
    )
    tools = _tools({"list_cases": ToolCallResult("Error calling list_cases: 501 not yet", True)})
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="remind")]}, _config("c1"), context=_context(llm, tools)
    )
    answer = result["messages"][-1].content
    assert answer.startswith("I created a reminder for you.")
    assert NO_ACTION in answer
    assert "- 501 not yet" in answer
    # Replaced in place, not added: one final AI message.
    assert sum(isinstance(m, AIMessage) and not m.tool_calls for m in result["messages"]) == 1


async def test_prepare_case_action_needs_approval_and_counts_as_prepared():
    llm = ScriptedFakeChatModel(
        responses=[
            _call(
                "prepare_case_action",
                {"caseID": "delivery:4500000001/10", "expectedFingerprint": "fp-1"},
                "act",
            ),
            AIMessage(content="The reminder draft is prepared and waits in Approvals."),
        ]
    )
    receipt = {"actionID": "a1", "caseID": "delivery:4500000001/10", "sourceFingerprint": "fp-1"}
    tools = _tools({"prepare_case_action": ToolCallResult(json.dumps(receipt), False, receipt)})
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    config, context = _config("a1"), _context(llm, tools)
    interrupted = await graph.ainvoke(
        {"messages": [HumanMessage(content="prepare it")]}, config, context=context
    )
    (approval,) = interrupted["__interrupt__"]
    assert approval.value["calls"][0]["name"] == "prepare_case_action"
    resumed = await graph.ainvoke(
        Command(resume={"approved_tool_call_ids": ["act"]}), config, context=context
    )
    assert NO_ACTION not in resumed["messages"][-1].content
    assert resumed["outcomes"][0].success


async def test_price_preparation_preserves_responsible_context_through_approval():
    arguments = {
        "caseID": "price:4500000001/10",
        "expectedFingerprint": "fp-price",
        "responsiblePerson": "Buyer D01",
        "responsibleMessage": "Explain the tenfold price difference.",
    }
    llm = ScriptedFakeChatModel(
        responses=[
            _call("prepare_case_action", arguments, "price"),
            AIMessage(content="The price clarification waits in Approvals."),
        ]
    )
    receipt = {
        "actionID": "p1",
        "caseID": arguments["caseID"],
        "sourceFingerprint": arguments["expectedFingerprint"],
    }
    tools = _tools({"prepare_case_action": ToolCallResult(json.dumps(receipt), False, receipt)})
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    config, context = _config("price-context"), _context(llm, tools)
    interrupted = await graph.ainvoke(
        {"messages": [HumanMessage(content="Prepare the clarification")]}, config, context=context
    )
    (approval,) = interrupted["__interrupt__"]
    approved = approval.value["calls"][0]["args"]
    assert {key: approved[key] for key in arguments} == arguments
    assert approved["commandID"]
    resumed = await graph.ainvoke(
        Command(resume={"approved_tool_call_ids": ["price"]}), config, context=context
    )
    assert NO_ACTION not in resumed["messages"][-1].content

    assert ("prepare_case_action", approved) in tools.calls
    assert resumed["outcomes"][0].success


async def test_lead_time_app_fails_closed_without_its_cap_profile():
    tools = FakeToolClient(
        tools=[ToolSpec("list_open_po_items", "", {}, True)],
        profile=ConnectionError("profile unavailable"),
    )
    llm = ScriptedFakeChatModel(responses=[AIMessage(content="I created a reminder.")])
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    context = {**_context(llm, tools), "app_id": "lead-time"}
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="hi")]}, _config("lt"), context=context
    )
    assert [t.name for t in result["tools"]] == []
    assert result["messages"][-1].content == "I created a reminder."
    assert tools.calls == [("profile", {})]


async def test_offline_model_calls_priorities_in_the_cockpit():
    item = "#/DeliveryRisks('delivery:4500000001/10')"
    data = {"rows": [{"PurchaseOrder": "4500000001", "PurchaseOrderItem": "10", "link": item}]}
    tools = _tools({"list_priorities": ToolCallResult(json.dumps(data), False, data)})
    graph = build_graph(checkpointer=InMemorySaver(serde=serializer()))
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="top")]},
        _config("off"),
        context=_context(OfflineChatModel(), tools),
    )
    assert result["messages"][1].tool_calls[0]["name"] == "list_priorities"
    assert f"[PO 4500000001/10]({item})" in result["messages"][-1].content


def test_offline_model_uses_tide_greeting():
    response = OfflineChatModel()._reply(
        [
            SystemMessage(content=SYSTEM_PROMPT),
            HumanMessage(content="Hello"),
        ]
    )
    assert response.content == "Hey! What would you like to check in TIDE, your purchasing desk?"


def test_offline_model_answers_capability_question_instead_of_greeting():
    response = OfflineChatModel()._reply(
        [
            SystemMessage(content=SYSTEM_PROMPT),
            HumanMessage(content="What can you do?"),
        ]
    )
    assert "Hey!" not in response.content
    assert "delivery risks" in response.content
    assert "prices" in response.content
