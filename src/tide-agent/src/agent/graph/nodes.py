"""Graph nodes: prepare -> llm -> route -> [approve] -> tools -> llm ... -> check.

Tool calls always receive results, system prompts are never persisted, and each
app's authorized CAP profile controls its tools and end-of-turn checks.
"""

from __future__ import annotations

import json
from typing import Any, Literal
from uuid import uuid4

from langchain_core.callbacks import adispatch_custom_event
from langchain_core.messages import (
    AIMessage,
    AnyMessage,
    HumanMessage,
    RemoveMessage,
    SystemMessage,
    ToolMessage,
)
from langgraph.graph.message import REMOVE_ALL_MESSAGES
from langgraph.runtime import Runtime
from langgraph.types import interrupt

from agent.app.execution import (
    execute_with_recovery as _execute_with_recovery,
)
from agent.app.execution import (
    execution_outcome as _execution_outcome,
)
from agent.app.execution import (
    owns_command_id as owns_command_id,
)
from agent.app.execution import (
    recover_write_attempts as recover_write_attempts,
)
from agent.app.execution import (
    restore_write_messages as restore_write_messages,
)
from agent.app.execution import (
    tool_content as _tool_content,
)
from agent.app.execution import (
    truncate as _truncate,
)
from agent.app.execution import (
    unknown_write_result as unknown_write_result,
)
from agent.app.execution import (
    verification_notes as _verification_notes,
)
from agent.graph.context import AgentContext
from agent.graph.state import (
    AgentProfile,
    AgentState,
    ExecutionOutcome,
    PendingToolCall,
)
from agent.policy.approval import ApprovalPolicy
from agent.policy.budget import affordable, charge, new_budget
from agent.policy.checks import ToolOutcome, TurnRules, check_turn
from agent.policy.plan import usable_schema, valid_arguments, validate_plan
from agent.policy.strip import split_card
from agent.policy.trim import fit_prompt, trim_history
from agent.ports.tools import ToolCallResult, ToolSpec, json_array, json_object

SYSTEM_PROMPT = (
    "You are TIDE, the buyer's purchasing desk. For a simple social greeting only, "
    "reply briefly: 'Hey! What would you like to check in TIDE, your purchasing desk?' "
    "Do not use that greeting as the answer to a substantive question. If asked what "
    "you can do, briefly explain that you can check purchasing data such as delivery "
    "risks, orders, prices, planned delivery times, requisitions, and prepare predictions "
    "or actions for the buyer's decision. "
    "You act on behalf of the authenticated "
    "user via typed tools that call a SAP CAP backend — you have no other "
    "source of truth. Answer only from tool results; never invent data. If a "
    "tool call fails, report the failure honestly."
)

FINAL_PROMPT = (
    "The tool budget for this turn is used up; no more tools can be called. "
    "Answer the user now from the results you already have, and say what is "
    "still missing."
)

BUDGET_EXHAUSTED_TEXT = (
    "I reached this turn's limit for steps and tool calls before I could finish. "
    "Ask again, possibly with a narrower question, to continue."
)
PROMPT_EXHAUSTED_TEXT = "This turn exceeds the model's context limit. Please narrow the request."

DANGLING_CALL_TEXT = (
    "No verified result is available for this call; its execution outcome is unknown."
)
OVER_BUDGET_TEXT = "Not run: this turn's tool-call budget is used up."
UNAVAILABLE_TEXT = "Tool is not available in this app."
DECLINED_TEXT = "User declined this action."
REPLAN_TEXT = "Not run: replan after the prior step completed."


# Apps the agent accepts; what they may do is CAP's to say.
APP_IDS = frozenset({"cockpit"})
# Retired apps: their threads stay readable but take no new turns.
RETIRED_APP_IDS = frozenset({"lead-time", "tabpfn-playground"})
NO_PROFILE_TEXT = (
    "The tools of this app could not be loaded right now. Say that the assistant "
    "cannot look anything up at the moment and ask the user to try again later."
)


def _closed_profile() -> AgentProfile:
    """Minimal fallback when CAP gives no profile: no tools (fail closed)."""
    return {
        "instructions": SYSTEM_PROMPT + " " + NO_PROFILE_TEXT,
        "tools": [],
        "action_tools": [],
        "checked": True,
    }


async def load_profile(ctx: AgentContext, catalog: list[ToolSpec]) -> AgentProfile:
    """Instructions, action tools and checks of the app for this turn, read from CAP.

    The app's MCP endpoint is its catalog; any failure to read its instructions or
    runtime profile leaves the turn without tools (fail closed).
    """
    try:
        instructions = await ctx.tool_catalog.instructions(authorization=ctx.authorization)
        data = await ctx.tool_catalog.profile(authorization=ctx.authorization)
    except Exception:  # noqa: BLE001 - any transport failure means no tools
        return _closed_profile()
    if not instructions:
        return _closed_profile()
    tools = {tool.name for tool in catalog}
    action_names: list[Any] = json_array(data.get("actionTools")) or []
    checked = bool(data.get("checked", True))
    return {
        "instructions": SYSTEM_PROMPT + "\n\n" + instructions,
        "tools": sorted(tools),
        "action_tools": sorted({str(name) for name in action_names} & tools),
        "checked": checked,
        "checks": _checks(data.get("checks")) if checked else {},
    }


async def resolve_page_context(ctx: AgentContext) -> dict[str, Any]:
    """Resolve a browser hint through CAP under the caller's authorization."""
    page_context = ctx.page_context
    if not page_context or ctx.app_id != "cockpit":
        return {}
    try:
        data = await ctx.tool_catalog.resolve_context(
            json.dumps(page_context, separators=(",", ":")), authorization=ctx.authorization
        )
    except Exception:  # noqa: BLE001 - context is advisory; fail closed to no context
        return {}
    if data.get("valid") is not True:
        return {}
    return {
        "profile": str(data.get("profile") or "generic")[:64],
        "canonicalContext": str(data.get("canonicalContext") or "")[:2000],
        "instructions": str(data.get("instructions") or "")[:4000],
    }


def _checks(raw: object) -> dict[str, Any]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = None
    return json_object(raw) or {}


def _profile(state: AgentState) -> AgentProfile:
    return state.get("profile") or {
        "instructions": SYSTEM_PROMPT,
        "tools": [],
        "action_tools": [],
        "checked": False,
    }


# ---------------------------------------------------------------- prepare


async def prepare(state: AgentState, runtime: Runtime[AgentContext]) -> dict[str, Any]:
    """Start a turn: fresh budget and catalog, repaired and trimmed history."""
    ctx = runtime.context
    catalog = await ctx.tool_catalog.list_tools(authorization=ctx.authorization)
    profile = await load_profile(ctx, catalog)
    page_context = await resolve_page_context(ctx)
    ctx.page_context_resolution.clear()
    ctx.page_context_resolution.update(page_context)
    allowed = set(profile["tools"])
    tools = [tool for tool in catalog if tool.name in allowed and usable_schema(tool.input_schema)]

    if ctx.write_attempts is not None:
        previous_writes = {tool.name for tool in state.get("tools", []) if not tool.read_only}
        answered = {
            message.tool_call_id
            for message in state.get("messages", [])
            if isinstance(message, ToolMessage)
        }
        candidates = list(state.get("approved_calls", []))
        previous_plan = state.get("plan")
        proposed = previous_plan.next_call() if previous_plan else None
        if proposed is not None and all(call.id != proposed.id for call in candidates):
            candidates.append(proposed)
        for call in candidates:
            if call.name in previous_writes and call.id not in answered:
                await ctx.write_attempts.begin(ctx.thread_id, ctx.user_id, ctx.app_id, call)
    attempts, recovered = await recover_write_attempts(ctx, tools)
    messages = restore_write_messages(
        state.get("messages", []), attempts, ctx.max_tool_result_chars
    )
    conversation: list[AnyMessage] = [m for m in messages if not isinstance(m, SystemMessage)]
    missing = {
        message.tool_call_id: message
        for message in _answer_dangling_calls(conversation, DANGLING_CALL_TEXT)
    }
    repaired: list[AnyMessage] = []
    for message in conversation:
        repaired.append(message)
        if isinstance(message, AIMessage):
            repaired.extend(
                missing[call["id"]] for call in message.tool_calls if call["id"] in missing
            )
    conversation = repaired
    dropped = trim_history(conversation, max_tokens=ctx.max_history_tokens)
    dropped_ids = {message.id for message in dropped}
    updates: list[AnyMessage | RemoveMessage] = [
        RemoveMessage(id=REMOVE_ALL_MESSAGES),
        *(message for message in conversation if message.id not in dropped_ids),
    ]
    unresolved = [outcome for outcome in recovered if not outcome.success]
    if any(outcome.status in {"pending", "unknown"} for outcome in unresolved):
        tools = [tool for tool in tools if tool.read_only]

    return {
        "messages": updates,
        "budget": new_budget(max_steps=ctx.max_steps, max_tool_calls=ctx.max_tool_calls),
        "tools": tools,
        "profile": profile,
        "approved_calls": [],
        "plan": None,
        "outcomes": unresolved,
        "verification_notes": _verification_notes(unresolved),
    }


def _answer_dangling_calls(messages: list[AnyMessage], text: str) -> list[ToolMessage]:
    """Tool results for calls that never got one.

    Happens when the user sends new input instead of deciding a pending
    approval (the API rejects that with 409, so this is the defensive path)
    or when a turn crashed between the LLM call and the tools.
    """
    answered = {m.tool_call_id for m in messages if isinstance(m, ToolMessage)}
    return [
        ToolMessage(content=text, tool_call_id=call["id"], status="error")
        for m in messages
        if isinstance(m, AIMessage)
        for call in m.tool_calls
        if call["id"] not in answered
    ]


# ---------------------------------------------------------------- llm


async def call_llm(state: AgentState, runtime: Runtime[AgentContext]) -> dict[str, Any]:
    tools: list[ToolSpec] = state["tools"]
    openai_tools = [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": (
                    {
                        **t.input_schema,
                        "properties": {
                            key: value
                            for key, value in t.input_schema.get("properties", {}).items()
                            if key != "commandID"
                        },
                        "required": [
                            key for key in t.input_schema.get("required", []) if key != "commandID"
                        ],
                    }
                    if owns_command_id(t)
                    else t.input_schema
                ),
            },
        }
        for t in tools
    ]
    llm = runtime.context.llm
    bound = llm.bind_tools(openai_tools) if openai_tools else llm
    verification = state.get("verification_notes", [])
    prompt = [
        SystemMessage(content=_profile(state)["instructions"]),
        *(
            [SystemMessage(content=str(runtime.context.page_context_resolution["instructions"]))]
            if runtime.context.page_context_resolution.get("instructions")
            else []
        ),
        *(
            [
                SystemMessage(
                    content=(
                        "Verified current UI context for this turn "
                        "(advisory; verify through authorized tools):\n"
                    )
                    + str(runtime.context.page_context_resolution["canonicalContext"])
                )
            ]
            if runtime.context.page_context_resolution.get("canonicalContext")
            else []
        ),
        *(
            [SystemMessage(content="Verification before answering:\n" + "\n".join(verification))]
            if verification
            else []
        ),
        *state["messages"],
    ]
    bounded = fit_prompt(prompt, openai_tools, runtime.context.max_prompt_tokens)
    response = (
        await bound.ainvoke(bounded, max_tokens=runtime.context.max_output_tokens)
        if bounded is not None
        else AIMessage(content=PROMPT_EXHAUSTED_TEXT)
    )
    return {"messages": [response], "budget": charge(state["budget"], steps=1)}


def route_after_llm(
    state: AgentState, runtime: Runtime[AgentContext]
) -> Literal["plan", "finalize", "end"]:
    last = state["messages"][-1]
    if not isinstance(last, AIMessage) or not last.tool_calls:
        return "end"
    # The LLM wants tools but can't have them: answer its calls, then close.
    if state["budget"].tool_calls_left <= 0:
        return "finalize"
    return "plan"


# ---------------------------------------------------------------- plan


async def plan(state: AgentState, runtime: Runtime[AgentContext]) -> dict[str, Any]:
    """Create a typed plan and reject calls that cannot safely be scheduled."""
    existing_plan = state.get("plan")
    call = existing_plan.next_call() if existing_plan else None
    if call is not None:
        spec = next((tool for tool in state["tools"] if tool.name == call.name), None)
        return {"approved_calls": [call] if spec and spec.read_only else []}

    last = state["messages"][-1]
    assert isinstance(last, AIMessage)
    command_tools = {tool.name for tool in state["tools"] if owns_command_id(tool)}
    calls = [
        PendingToolCall(
            id=tc["id"] or str(uuid4()),
            name=tc["name"],
            args={**tc["args"], "commandID": str(uuid4())}
            if tc["name"] in command_tools
            else tc["args"],
        )
        for tc in last.tool_calls
    ]
    execution_plan, rejected = validate_plan(
        calls,
        tools=state["tools"],
        max_calls=affordable(state["budget"], len(calls)),
    )
    first = execution_plan.next_call()
    first_spec = next((tool for tool in state["tools"] if first and tool.name == first.name), None)

    return {
        "messages": [
            last.model_copy(
                update={
                    "tool_calls": [
                        {"id": call.id, "name": call.name, "args": call.args, "type": "tool_call"}
                        for call in calls
                    ]
                }
            ),
            *[_error(call, text) for call, text in rejected],
        ],
        "plan": execution_plan,
        "approved_calls": (
            [first] if first is not None and first_spec and first_spec.read_only else []
        ),
    }


def route_after_plan(
    state: AgentState, runtime: Runtime[AgentContext]
) -> Literal["tools", "request_approval", "llm", "finalize"]:
    execution_plan = state.get("plan")
    call = execution_plan.next_call() if execution_plan else None
    if call is None:
        return "finalize" if state["budget"].exhausted() else "llm"
    spec = next((tool for tool in state["tools"] if tool.name == call.name), None)
    if spec is not None and spec.read_only:
        return "tools"
    return "request_approval"


async def request_approval(state: AgentState, runtime: Runtime[AgentContext]) -> dict[str, Any]:
    """Pause for the next write step only; later work requires a replan."""
    execution_plan = state.get("plan")
    call = execution_plan.next_call() if execution_plan else None
    if call is None:
        return {"approved_calls": []}
    assert execution_plan is not None
    policy = ApprovalPolicy(tools_by_name={t.name: t for t in state["tools"]})
    request = policy.summarize([call])
    decision = interrupt({"summary": request.summary, "calls": [call.__dict__]})
    decision = json_object(decision)
    approved_ids: set[str] = (
        set(decision.get("approved_tool_call_ids", [])) if decision is not None else set()
    )
    approved = call.id in approved_ids
    if approved:
        ctx = runtime.context
        catalog = await ctx.tool_catalog.list_tools(authorization=ctx.authorization)
        profile = await load_profile(ctx, catalog)
        original = {tool.name for tool in state["tools"]}
        permitted = set(profile["tools"]) & original
        tools = [
            tool for tool in catalog if tool.name in permitted and usable_schema(tool.input_schema)
        ]
        if not any(
            tool.name == call.name and valid_arguments(call.args, tool.input_schema)
            for tool in tools
        ):
            return {
                "messages": [
                    _error(call, UNAVAILABLE_TEXT),
                    *_defer_remaining(execution_plan.advance()),
                ],
                "approved_calls": [],
                "plan": None,
                "tools": tools,
                "profile": profile,
                "outcomes": [
                    *state.get("outcomes", []),
                    _execution_outcome(call, ToolCallResult(UNAVAILABLE_TEXT, is_error=True)),
                ],
            }
        return {
            "approved_calls": [call],
            "plan": execution_plan,
            "tools": tools,
            "profile": profile,
        }
    declined = [] if approved else [_error(call, DECLINED_TEXT)]
    deferred = [] if approved else _defer_remaining(execution_plan.advance())
    return {
        "messages": [*declined, *deferred],
        "approved_calls": [call] if approved else [],
        "plan": execution_plan if approved else None,
    }


def _error(call: PendingToolCall, text: str) -> ToolMessage:
    return ToolMessage(content=text, tool_call_id=call.id, status="error")


# ---------------------------------------------------------------- execute and verify


async def run_tools(state: AgentState, runtime: Runtime[AgentContext]) -> dict[str, Any]:
    ctx = runtime.context
    to_run: list[PendingToolCall] = state.get("approved_calls", [])
    available = {tool.name for tool in state["tools"]}
    profile = _profile(state)
    allowed = set(profile["tools"])
    outcomes: list[ExecutionOutcome] = list(state.get("outcomes", []))
    read_tools = frozenset(
        tool.name for tool in state["tools"] if tool.read_only and tool.name in allowed
    )

    async def run_one(call: PendingToolCall) -> ToolMessage:
        if call.name not in allowed or call.name not in available:
            outcomes.append(
                _execution_outcome(call, ToolCallResult(UNAVAILABLE_TEXT, is_error=True))
            )
            return _error(call, UNAVAILABLE_TEXT)
        spec = next(tool for tool in state["tools"] if tool.name == call.name)
        if not spec.read_only and ctx.write_attempts is not None:
            fresh = await ctx.write_attempts.begin(ctx.thread_id, ctx.user_id, ctx.app_id, call)
            if fresh:
                result = await _execute_with_recovery(ctx, spec, call, read_tools=read_tools)
            else:
                attempts, _ = await recover_write_attempts(ctx, state["tools"])
                attempt = next(attempt for attempt in attempts if attempt.call.id == call.id)
                result = attempt.result or unknown_write_result()
            retained = ToolCallResult(
                _truncate(_tool_content(result), ctx.max_tool_result_chars),
                result.is_error,
                _execution_outcome(call, result).data,
                result.error,
            )
            await ctx.write_attempts.finish(ctx.thread_id, ctx.user_id, ctx.app_id, call, retained)
        else:
            result = await _execute_with_recovery(ctx, spec, call, read_tools=read_tools)
        outcome = _execution_outcome(call, result)
        outcomes.append(outcome)
        content = _tool_content(result)
        artifact = None
        if profile.get("checked") and not result.is_error and result.data is not None:
            # Keep CAP's UI-only card out of the model-visible tool result.
            data, card = split_card(result.data)
            artifact = {"card": card} if card is not None else None
            content = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        return ToolMessage(
            content=_truncate(content, ctx.max_tool_result_chars),
            tool_call_id=call.id,
            status="error" if result.is_error or not outcome.success else "success",
            artifact=artifact,
        )

    # A plan executes exactly one dependency-ready call. The verified plan is
    # retained, so dependent calls run in model-specified order rather than in
    # parallel or with guessed intermediate values.
    results = [await run_one(to_run[0])] if to_run else []
    execution_plan = state.get("plan")
    remaining_plan = execution_plan.advance() if to_run and execution_plan else None
    failed = bool(to_run and not outcomes[-1].success)
    deferred = _defer_remaining(remaining_plan) if failed and remaining_plan else []
    return {
        "messages": [*results, *deferred],
        "approved_calls": [],
        "plan": None if failed else remaining_plan,
        "outcomes": outcomes,
        "budget": charge(state["budget"], tool_calls=len(to_run)),
    }


async def verify(state: AgentState, runtime: Runtime[AgentContext]) -> dict[str, Any]:
    """Validate the completed step before the model can claim task completion."""
    return {"verification_notes": _verification_notes(state.get("outcomes", []))}


def route_after_execute(
    state: AgentState, runtime: Runtime[AgentContext]
) -> Literal["verify", "llm", "finalize"]:
    if state.get("outcomes"):
        return "verify"
    return "finalize" if state["budget"].exhausted() else "llm"


def route_after_verify(
    state: AgentState, runtime: Runtime[AgentContext]
) -> Literal["plan", "llm", "finalize"]:
    execution_plan = state.get("plan")
    if execution_plan and execution_plan.next_call():
        return "plan"
    return "finalize" if state["budget"].exhausted() else "llm"


def _defer_remaining(execution_plan: object) -> list[ToolMessage]:
    if execution_plan is None:
        return []
    calls = getattr(execution_plan, "calls", ())
    current = int(getattr(execution_plan, "current", 0))
    return [
        ToolMessage(content=REPLAN_TEXT, tool_call_id=call.id, status="error")
        for call in calls[current:]
    ]


# ---------------------------------------------------------------- check


TURN_EVENT = "tide.turn"


async def check(state: AgentState, runtime: Runtime[AgentContext]) -> dict[str, Any]:
    """End-of-turn checks in code (P-9) for apps with a checked profile.

    Appends what the answer must show but does not (no prepared action,
    unquoted tool errors, warnings and the prediction check) to the final
    answer. The appendix also goes to the client as a `tide.turn` custom
    event, because the answer itself was already streamed.
    """
    verification = (
        state.get("verification_notes", [])
        if any(
            outcome.status in {"pending", "unknown"}
            or (outcome.status == "failed" and outcome.data)
            for outcome in state.get("outcomes", [])
        )
        else []
    )
    if not _profile(state).get("checked") and not verification:
        return {}
    messages = state["messages"]
    last = messages[-1] if messages else None
    if not isinstance(last, AIMessage) or last.tool_calls:
        return {}
    start = max((i for i, m in enumerate(messages) if isinstance(m, HumanMessage)), default=-1)
    calls = {
        tc["id"]: tc["name"]
        for m in messages[start + 1 :]
        if isinstance(m, AIMessage)
        for tc in m.tool_calls
    }
    action_tools = set(_profile(state).get("action_tools") or [])
    outcomes = [
        ToolOutcome(
            name=calls.get(m.tool_call_id, "tool"),
            content=str(m.content),
            is_error=m.status == "error",
            prepared_action=calls.get(m.tool_call_id) in action_tools,
        )
        for m in messages[start + 1 :]
        if isinstance(m, ToolMessage) and m.content not in (DECLINED_TEXT, UNAVAILABLE_TEXT)
    ]
    answer = str(last.content or "")
    result = check_turn(answer, outcomes, TurnRules.from_cap(_profile(state).get("checks") or {}))
    result.notes.extend(note for note in verification if note not in answer)
    try:
        await adispatch_custom_event(
            TURN_EVENT,
            {"messageId": last.id, "append": result.appendix},
        )
    except RuntimeError:
        pass  # no callback context (plain ainvoke in tests)
    if not result.notes:
        return {}
    joined = f"{answer}\n\n{result.appendix}" if answer else result.appendix
    return {"messages": [AIMessage(content=joined, id=last.id)]}


# ---------------------------------------------------------------- finalize


async def finalize(state: AgentState, runtime: Runtime[AgentContext]) -> dict[str, Any]:
    """End an over-budget turn with an answer.

    Answers any tool calls of the last AI message that got no result, then
    makes one last LLM call without tools. If the step budget doesn't allow
    that call, a fixed message ends the turn instead.
    """
    messages = state["messages"]
    # reached straight from `llm`: its tool calls were never run
    closing = _answer_dangling_calls(messages, OVER_BUDGET_TEXT)
    if state["budget"].steps_left <= 0:
        return {"messages": [*closing, AIMessage(content=BUDGET_EXHAUSTED_TEXT)]}

    prompt = [
        SystemMessage(content=_profile(state)["instructions"]),
        *messages,
        *closing,
        SystemMessage(content=FINAL_PROMPT),
    ]
    bounded = fit_prompt(prompt, [], runtime.context.max_prompt_tokens)
    response = (
        await runtime.context.llm.ainvoke(bounded, max_tokens=runtime.context.max_output_tokens)
        if bounded is not None
        else AIMessage(content=PROMPT_EXHAUSTED_TEXT)
    )
    if response.tool_calls or not response.content:
        # No tools were bound, but don't trust the model to comply.
        response = AIMessage(content=BUDGET_EXHAUSTED_TEXT)
    return {
        "messages": [*closing, response],
        "budget": charge(state["budget"], steps=1),
    }
