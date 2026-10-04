"""Tool execution, durable write recovery, and verified outcome classification."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Literal

from langchain_core.messages import AIMessage, AnyMessage, ToolMessage

from agent.graph.context import AgentContext
from agent.graph.state import ExecutionOutcome, PendingToolCall
from agent.ports.tools import ToolCallResult, ToolFailure, ToolSpec, json_object
from agent.ports.writes import WriteAttempt

_MAX_READ_RETRIES = 2
_MAX_POLLS = 3
PREDICTION_STARTS = frozenset({"start_prediction", "start_lead_time_prediction"})
RUN_TOOL = "get_prediction_run"


def owns_command_id(tool: ToolSpec) -> bool:
    """A write whose schema requires commandID: the agent, not the model, supplies the key."""
    return not tool.read_only and "commandID" in (tool.input_schema.get("required") or [])


def is_command(call: PendingToolCall) -> bool:
    return isinstance(call.args.get("commandID"), str)


def verification_notes(outcomes: list[ExecutionOutcome]) -> list[str]:
    notes: list[str] = []
    for outcome in outcomes:
        if not outcome.success:
            identity = (outcome.data or {}).get("actionID") or (outcome.data or {}).get("ID")
            suffix = f" for run {identity}" if identity else ""
            notes.append(
                f"{outcome.call.name}: outcome {outcome.status}{suffix}; "
                "do not claim successful completion."
            )
            continue
        if outcome.call.name in PREDICTION_STARTS and not (
            isinstance(outcome.data, dict) and outcome.data.get("ID") and outcome.data.get("status")
        ):
            notes.append(
                f"{outcome.call.name} was not verified: CAP returned no prediction run ID "
                "and status."
            )
    return notes


def execution_outcome(call: PendingToolCall, result: ToolCallResult) -> ExecutionOutcome:
    source = json_object(result.data) or result_data(result.content)
    source = source or {}
    nested = json_object(source.get("result"))
    values = {**source, **nested} if source.get("reused") and nested is not None else source
    data = {
        key: value
        for key in (
            "ID",
            "status",
            "existingId",
            "reused",
            "commandID",
            "commandType",
            "caseID",
            "actionID",
            "submissionID",
            "sourceFingerprint",
            "payloadMatched",
        )
        if isinstance(value := values.get(key), (str, bool))
        and (not isinstance(value, str) or len(value) <= 256)
    }
    error_code = result.error.code if result.error else result_error_code(result.content)
    status: Literal["completed", "pending", "failed", "unknown"] = "completed"
    if result.is_error:
        status = (
            "unknown"
            if error_code in {"OUTCOME_UNKNOWN", "UPSTREAM_OUTCOME_UNKNOWN", "MCP_TRANSPORT"}
            else "failed"
        )
    elif data.get("status") in {"pending", "running"}:
        status = "pending"
    elif data.get("status") in {"failed", "cancelled", "canceled"}:
        status = "failed"
    elif is_command(call) and (
        data.get("caseID") != call.args.get("caseID")
        or not data.get("actionID")
        or ("expectedReviewToken" in call.args and not data.get("submissionID"))
        or (data.get("commandID") is not None and data["commandID"] != call.args.get("commandID"))
        or (
            call.args.get("expectedFingerprint")
            and data.get("sourceFingerprint") != call.args["expectedFingerprint"]
        )
    ):
        status = "unknown"
    elif call.name in {*PREDICTION_STARTS, RUN_TOOL} and not (
        data.get("ID") and data.get("status") == "succeeded"
    ):
        status = "unknown"
    return ExecutionOutcome(
        call=call,
        success=status == "completed",
        data=data or None,
        error_code=error_code,
        status=status,
        retryable=bool(result.error and result.error.retryable and status != "unknown"),
        reference=result.error.reference if result.error else None,
    )


async def execute_with_recovery(
    ctx: AgentContext, spec: ToolSpec, call: PendingToolCall, *, read_tools: frozenset[str]
) -> ToolCallResult:
    """Retry safe reads, poll pending predictions, and reconcile typed conflicts."""
    attempts = _MAX_READ_RETRIES if spec.read_only else 1
    result: ToolCallResult | None = None
    for attempt in range(attempts):
        try:
            result = await ctx.tool_executor.call_tool(
                call.name, call.args, authorization=ctx.authorization
            )
        except Exception:  # noqa: BLE001 - transport failures become tool results
            result = ToolCallResult(
                content="The tool connection failed.",
                is_error=True,
                error=ToolFailure(
                    code="MCP_TRANSPORT", message="The tool connection failed.", retryable=True
                ),
            )
        if (
            not result.is_error
            or not spec.read_only
            or not result.error
            or not result.error.retryable
        ):
            break
        if attempt + 1 < attempts:
            await asyncio.sleep(min(result.error.retry_after_ms or 50, 250) / 1000)
    assert result is not None
    if result.is_error and result.error and result.error.code == "CONFLICT":
        result = await reconcile_conflict(ctx, result, read_tools=read_tools)
    if (
        is_command(call)
        and result.is_error
        and result.error
        and result.error.code in {"MCP_TRANSPORT", "OUTCOME_UNKNOWN", "UPSTREAM_OUTCOME_UNKNOWN"}
    ):
        result = await reconcile_workflow_command(ctx, call, result, read_tools=read_tools)
    return await poll_pending(ctx, result, read_tools=read_tools)


async def reconcile_workflow_command(
    ctx: AgentContext, call: PendingToolCall, result: ToolCallResult, *, read_tools: frozenset[str]
) -> ToolCallResult:
    """Read CAP's receipt for the exact attempted arguments; only a matching receipt counts."""
    command_id = call.args.get("commandID")
    if not isinstance(command_id, str) or not command_id:
        return result
    arguments = {key: value for key, value in call.args.items() if key != "commandID"}
    try:
        receipt = await ctx.tool_executor.command_result(
            call.name,
            command_id,
            json.dumps(arguments, separators=(",", ":")),
            authorization=ctx.authorization,
        )
    except Exception:  # noqa: BLE001 - an unavailable receipt cannot establish the write outcome
        return result
    receipt_data = json_object(receipt.data)
    if receipt.is_error or receipt_data is None:
        return result
    if (
        receipt_data.get("payloadMatched") is not True
        or receipt_data.get("commandID") != command_id
        or receipt_data.get("caseID") != call.args.get("caseID")
        or (
            "expectedFingerprint" in call.args
            and receipt_data.get("sourceFingerprint") != call.args["expectedFingerprint"]
        )
        or not receipt_data.get("actionID")
    ):
        return result
    return receipt


async def reconcile_conflict(
    ctx: AgentContext, result: ToolCallResult, *, read_tools: frozenset[str]
) -> ToolCallResult:
    failure = result.error
    if (
        not failure
        or failure.reconcile_tool not in read_tools
        or failure.reconcile_arguments is None
    ):
        return result
    try:
        reconciled = await ctx.tool_executor.call_tool(
            failure.reconcile_tool, failure.reconcile_arguments, authorization=ctx.authorization
        )
    except Exception:  # noqa: BLE001 - preserve the original conflict
        return result
    if reconciled.is_error:
        return result
    data = {"reused": True, "existingId": failure.existing_id, "result": reconciled.data}
    return ToolCallResult(content=json.dumps(data, ensure_ascii=False), is_error=False, data=data)


async def poll_pending(
    ctx: AgentContext, result: ToolCallResult, *, read_tools: frozenset[str]
) -> ToolCallResult:
    data = json_object(result.data)
    if (
        RUN_TOOL not in read_tools
        or data is None
        or data.get("status") not in {"pending", "running"}
        or not data.get("ID")
    ):
        return result
    for _ in range(_MAX_POLLS):
        await asyncio.sleep(0.05)
        try:
            polled = await ctx.tool_executor.call_tool(
                RUN_TOOL, {"runId": data["ID"]}, authorization=ctx.authorization
            )
        except Exception:  # noqa: BLE001 - return the latest durable run state
            return result
        if polled.is_error:
            return polled
        result, data = polled, json_object(polled.data)
        if data is None or data.get("status") not in {"pending", "running"}:
            return result
    return result


def unknown_write_result() -> ToolCallResult:
    return ToolCallResult(
        "The write outcome is unknown; it must not be retried.",
        True,
        error=ToolFailure(
            "OUTCOME_UNKNOWN", "The write outcome is unknown; it must not be retried."
        ),
    )


async def recover_write_attempts(
    ctx: AgentContext,
    tools: list[ToolSpec],
) -> tuple[list[WriteAttempt], list[ExecutionOutcome]]:
    if ctx.write_attempts is None:
        return [], []
    attempts = await ctx.write_attempts.list_attempts(ctx.thread_id, ctx.user_id, ctx.app_id)
    read_tools = frozenset(tool.name for tool in tools if tool.read_only)
    recovered: list[WriteAttempt] = []
    outcomes: list[ExecutionOutcome] = []
    for attempt in attempts:
        result = attempt.result or unknown_write_result()
        outcome = execution_outcome(attempt.call, result)
        if outcome.status == "unknown" and is_command(attempt.call):
            result = await reconcile_workflow_command(
                ctx, attempt.call, result, read_tools=read_tools
            )
        elif outcome.status == "pending":
            result = await poll_pending(ctx, result, read_tools=read_tools)
        outcome = execution_outcome(attempt.call, result)
        retained = ToolCallResult(
            truncate(tool_content(result), ctx.max_tool_result_chars),
            result.is_error,
            outcome.data,
            result.error,
        )
        if outcome.status != "unknown" or attempt.result is not None:
            await ctx.write_attempts.finish(
                ctx.thread_id, ctx.user_id, ctx.app_id, attempt.call, retained
            )
        recovered.append(WriteAttempt(attempt.call, retained))
        outcomes.append(outcome)
    return recovered, outcomes


def restore_write_messages(
    messages: list[AnyMessage],
    attempts: list[WriteAttempt],
    limit: int,
) -> list[AnyMessage]:
    repairs: dict[str, ToolMessage] = {}
    for attempt in attempts:
        result = attempt.result or unknown_write_result()
        outcome = execution_outcome(attempt.call, result)
        repairs[attempt.call.id] = ToolMessage(
            content=truncate(tool_content(result), limit),
            tool_call_id=attempt.call.id,
            id=f"tide-write:{attempt.call.id}",
            status="success" if outcome.success else "error",
        )
    existing = {message.tool_call_id for message in messages if isinstance(message, ToolMessage)}
    restored: list[AnyMessage] = []
    for message in messages:
        if isinstance(message, ToolMessage) and message.tool_call_id in repairs:
            replacement = repairs[message.tool_call_id]
            if message.status == "success" and replacement.status == "success":
                restored.append(message)
            else:
                restored.append(replacement.model_copy(update={"id": message.id or replacement.id}))
        else:
            restored.append(message)
            if isinstance(message, AIMessage):
                restored.extend(
                    repairs[call["id"]]
                    for call in message.tool_calls
                    if call["id"] in repairs and call["id"] not in existing
                )
    return restored


def result_data(content: str) -> dict[str, Any] | None:
    try:
        value = json.loads(content)
    except ValueError:
        return None
    return json_object(value)


def result_error_code(content: str) -> str | None:
    data = result_data(content)
    error = json_object(data.get("error")) if data else None
    return str(error.get("code")) if error is not None and error.get("code") else None


def truncate(content: str, limit: int) -> str:
    if len(content) <= limit:
        return content
    return (
        content[:limit]
        + f"\n[truncated: {len(content) - limit} of {len(content)} characters not shown]"
    )


def tool_content(result: ToolCallResult) -> str:
    if not result.is_error or not result.error:
        return result.content
    return json.dumps({"error": result.error.as_dict()}, ensure_ascii=False, separators=(",", ":"))
