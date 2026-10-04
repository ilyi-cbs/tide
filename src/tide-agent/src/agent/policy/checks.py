"""End-of-turn checks on the model's answer (P-9), in code, not in the prompt.

Rules come from `AssistantRuntimeService.profile().checks` in
`src/tide-cap/srv/cockpit/chat-view.ts` (NS-J1); this module applies them without
inventing source text.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from agent.ports.tools import json_array, json_object

_ERROR_PREFIX = re.compile(r"^Error calling \w+:\s*", re.I)


@dataclass(frozen=True)
class ToolOutcome:
    """One tool result of the turn, as the model saw it."""

    name: str
    content: str
    is_error: bool
    prepared_action: bool = False


@dataclass(frozen=True)
class TurnRules:
    no_action: str = ""
    action_claim: re.Pattern[str] | None = None
    negation: re.Pattern[str] | None = None
    expert_warning: re.Pattern[str] | None = None
    quote: tuple[tuple[str, tuple[str, ...]], ...] = ()

    @classmethod
    def from_cap(cls, raw: dict[str, Any]) -> TurnRules:
        def pattern(key: str) -> re.Pattern[str] | None:
            try:
                return re.compile(raw[key], re.I) if raw.get(key) else None
            except re.error:
                return None

        quotes: list[Any] = json_array(raw.get("quote")) or []
        quote = tuple(
            (str(q["field"]), tuple(str(v) for v in q.get("whenVerdict") or ()))
            for value in quotes
            if (q := json_object(value)) is not None and q.get("field")
        )
        return cls(
            no_action=str(raw.get("noAction") or ""),
            action_claim=pattern("actionClaim"),
            negation=pattern("negation"),
            expert_warning=pattern("expertWarning"),
            quote=quote,
        )


@dataclass
class TurnCheck:
    notes: list[str] = field(default_factory=lambda: list[str]())

    @property
    def appendix(self) -> str:
        return "\n\n".join(self.notes)


def _json(content: str) -> Any:
    try:
        return json.loads(content)
    except (TypeError, ValueError):
        return None


def _claims_action(answer: str, rules: TurnRules) -> bool:
    if rules.action_claim is None:
        return False
    for sentence in re.split(r"(?<=[.!?])\s+|\n", answer):
        if rules.action_claim.search(sentence) and not (
            rules.negation and rules.negation.search(sentence)
        ):
            return True
    return False


def _normalise(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def must_quote(outcomes: list[ToolOutcome], rules: TurnRules) -> list[str]:
    """Texts of the turn's tool results the answer has to contain."""
    texts: list[str] = []
    for o in outcomes:
        if o.is_error:
            if rules.quote:
                texts.append(_ERROR_PREFIX.sub("", o.content.strip()))
            continue
        data = json_object(_json(o.content))
        if data is None:
            continue
        for name, verdicts in rules.quote:
            if verdicts and data.get("verdict") not in verdicts:
                continue
            value = data.get(name)
            for text in json_array(value) or [value]:
                if not isinstance(text, str) or not text:
                    continue
                if (
                    name == "warnings"
                    and rules.expert_warning
                    and rules.expert_warning.search(text)
                ):
                    continue
                texts.append(text)
    return [t for t in dict.fromkeys(texts) if t]


def check_turn(answer: str, outcomes: list[ToolOutcome], rules: TurnRules) -> TurnCheck:
    result = TurnCheck()
    prepared = any(o.prepared_action and not o.is_error for o in outcomes)
    if rules.no_action and not prepared and _claims_action(answer, rules):
        result.notes.append(rules.no_action)
    low = _normalise(answer)
    missing = [t for t in must_quote(outcomes, rules) if _normalise(t) not in low]
    if missing:
        result.notes.append("\n".join(f"- {t}" for t in missing))
    return result
