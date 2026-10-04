from __future__ import annotations

import pytest

from agent.graph.state import Budget, PendingToolCall
from agent.policy.approval import ApprovalPolicy
from agent.policy.budget import charge, new_budget
from agent.policy.plan import validate_plan
from agent.ports.tools import ToolSpec


def test_approval_policy_splits_read_only_and_write_calls(read_only_tool, write_tool):
    policy = ApprovalPolicy(tools_by_name={t.name: t for t in (read_only_tool, write_tool)})
    calls = [
        PendingToolCall(id="1", name=read_only_tool.name, args={}),
        PendingToolCall(id="2", name=write_tool.name, args={"feed": "x"}),
    ]

    read_only, writes = policy.split(calls)

    assert [c.id for c in read_only] == ["1"]
    assert [c.id for c in writes] == ["2"]


def test_approval_policy_treats_unknown_tool_as_write():
    policy = ApprovalPolicy(tools_by_name={})
    calls = [PendingToolCall(id="1", name="unknownTool", args={})]

    read_only, writes = policy.split(calls)

    assert read_only == []
    assert [c.id for c in writes] == ["1"]


def test_approval_policy_summary_includes_each_call(write_tool):
    policy = ApprovalPolicy(tools_by_name={write_tool.name: write_tool})
    calls = [PendingToolCall(id="1", name=write_tool.name, args={"feed": "x"})]

    request = policy.summarize(calls)

    assert request.calls == tuple(calls)
    assert write_tool.name in request.summary
    assert write_tool.description in request.summary


def test_budget_charge_never_goes_below_zero():
    budget = new_budget(max_steps=1, max_tool_calls=1)

    charged = charge(budget, steps=5, tool_calls=5)

    assert charged.steps_left == 0
    assert charged.tool_calls_left == 0


def test_budget_exhausted():
    assert Budget(steps_left=0, tool_calls_left=5).exhausted() is True
    assert Budget(steps_left=5, tool_calls_left=0).exhausted() is True
    assert Budget(steps_left=1, tool_calls_left=1).exhausted() is False


@pytest.mark.parametrize(
    "arguments", [{}, {"amount": "wrong"}, {"amount": 0}, {"amount": 1, "extra": True}]
)
def test_schema_invalid_calls_are_rejected(arguments):
    schema = {
        "type": "object",
        "properties": {"amount": {"type": "integer", "minimum": 1}},
        "required": ["amount"],
        "additionalProperties": False,
    }
    plan, rejected = validate_plan(
        [PendingToolCall("c1", "read", arguments)],
        tools=[ToolSpec("read", "", schema, True)],
        max_calls=1,
    )
    assert not plan.calls
    assert len(rejected) == 1


def test_schema_rejection_names_the_field():
    schema = {
        "type": "object",
        "properties": {"key": {"type": "object", "properties": {"plant": {"type": "string"}}}},
    }
    _, [(_, text)] = validate_plan(
        [PendingToolCall("c1", "read", {"key": {"plant": 1010}})],
        tools=[ToolSpec("read", "", schema, True)],
        max_calls=1,
    )
    assert text.startswith("Tool arguments do not match its declared schema: key.plant: ")


PREDICT = ToolSpec(
    "predict_orders",
    "",
    {
        "type": "object",
        "properties": {"target": {"type": "string"}, "key": {"type": "object"}},
        "required": ["target"],
    },
    False,
)


def test_partial_prediction_key_is_rejected_before_approval():
    plan, [(_, text)] = validate_plan(
        [
            PendingToolCall(
                "c1", "predict_orders", {"target": "lead_time_days", "key": {"material": "M1"}}
            )
        ],
        tools=[PREDICT],
        max_calls=1,
    )
    assert not plan.calls
    assert "missing: supplier, plant" in text


@pytest.mark.parametrize(
    "args",
    [
        {"target": "lead_time_days"},
        {"target": "lead_time_days", "key": {"material": "M1", "supplier": "S1", "plant": "P1"}},
    ],
)
def test_prediction_without_key_or_with_complete_key_is_accepted(args):
    plan, rejected = validate_plan(
        [PendingToolCall("c1", "predict_orders", args)], tools=[PREDICT], max_calls=1
    )
    assert len(plan.calls) == 1
    assert not rejected


def test_remote_schema_reference_is_never_resolved():
    plan, rejected = validate_plan(
        [PendingToolCall("c1", "read", {})],
        tools=[ToolSpec("read", "", {"$ref": "https://invalid.example/schema"}, True)],
        max_calls=1,
    )
    assert not plan.calls
    assert len(rejected) == 1
