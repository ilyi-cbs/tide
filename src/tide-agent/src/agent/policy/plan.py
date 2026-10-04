"""Deterministic validation and scheduling of one model tool-call batch."""

from __future__ import annotations

from typing import Any, cast

from jsonschema import SchemaError, ValidationError
from jsonschema.exceptions import best_match  # pyright: ignore[reportUnknownVariableType]
from jsonschema.validators import validator_for
from referencing.exceptions import Unresolvable

from agent.graph.state import ExecutionPlan, PendingToolCall
from agent.ports.tools import ToolSpec, json_array, json_object

_ERROR_CHARS = 200
PREDICT_KEY_FIELDS = ("material", "supplier", "plant")


def validate_plan(
    calls: list[PendingToolCall],
    *,
    tools: list[ToolSpec],
    max_calls: int,
) -> tuple[ExecutionPlan, list[tuple[PendingToolCall, str]]]:
    """Return ordered executable calls and deterministic rejections.

    Model order is the dependency order. The executor runs one call at a time,
    which lets a later model turn use the prior result instead of guessing an
    identifier or racing a write.
    """
    available = {tool.name: tool for tool in tools}
    accepted: list[PendingToolCall] = []
    rejected: list[tuple[PendingToolCall, str]] = []
    for call in calls:
        if call.name not in available:
            rejected.append((call, "Tool is not available in this app."))
        elif (error := argument_error(call.args, available[call.name].input_schema)) is not None:
            rejected.append((call, f"Tool arguments do not match its declared schema: {error}"))
        elif (missing := _missing_predict_key(call)) is not None:
            rejected.append(
                (
                    call,
                    f"key needs all of material, supplier and plant; missing: {missing}. "
                    "Take them from rows already looked up, or ask the user.",
                )
            )
        elif "commandID" in available[call.name].input_schema.get("required", []) and any(
            not isinstance(call.args.get(key), str) or not call.args[key].strip()
            for key in available[call.name].input_schema.get("required", [])
            if key in {"commandID", "caseID", "expectedFingerprint", "expectedReviewToken"}
        ):
            rejected.append((call, "Workflow preparation requires its current evidence guards."))
        elif len(accepted) >= max_calls:
            rejected.append((call, "Not run: this turn's tool-call budget is used up."))
        else:
            accepted.append(call)
    return ExecutionPlan(calls=tuple(accepted)), rejected


def _missing_predict_key(call: PendingToolCall) -> str | None:
    # CAP's MCP schema leaves nested struct fields optional; CAP would reject only after approval.
    key = json_object(call.args.get("key")) if call.name == "predict_orders" else None
    if key is None:
        return None
    missing = [
        name
        for name in PREDICT_KEY_FIELDS
        if not isinstance(key.get(name), str) or not key[name].strip()
    ]
    return ", ".join(missing) or None


def local_schema(value: object) -> bool:
    mapping = json_object(value)
    if mapping is not None:
        return all(
            isinstance(item, str) and item.startswith("#")
            if key in {"$ref", "$dynamicRef"}
            else local_schema(item)
            for key, item in mapping.items()
        )
    items = json_array(value)
    if items is not None:
        return all(local_schema(item) for item in items)
    return True


def valid_arguments(arguments: dict[str, Any], schema: dict[str, Any]) -> bool:
    return argument_error(arguments, schema) is None


def argument_error(arguments: dict[str, Any], schema: dict[str, Any]) -> str | None:
    """None when the arguments match the schema, else the field and what is wrong."""
    if not usable_schema(schema):
        return "the tool schema is unusable"
    try:
        validator = validator_for(schema)
        validator.check_schema(schema)
        error = cast("ValidationError | None", best_match(validator(schema).iter_errors(arguments)))
    except (SchemaError, Unresolvable):
        return "the tool schema is unusable"
    if error is None:
        return None
    path = ".".join(str(part) for part in error.absolute_path) or "(arguments)"
    return f"{path}: {error.message}"[:_ERROR_CHARS]


def usable_schema(schema: dict[str, Any]) -> bool:
    if not local_schema(schema):
        return False
    try:
        validator_for(schema).check_schema(schema)
    except SchemaError:
        return False
    return True
