"""Result cards of tool results (P-9).

CAP filters cockpit results in `src/tide-cap/srv/cockpit/chat-view.ts` (NS-J2);
cards are moved to the UI artifact, outside model-visible tool content.
"""

from __future__ import annotations

import json
from typing import Any

from agent.ports.tools import json_object


def split_card(result: Any) -> tuple[Any, Any]:
    """(result without `card`, the parsed card or None)."""
    mapping = json_object(result)
    if mapping is None or mapping.get("card") is None:
        return result, None
    rest = {key: value for key, value in mapping.items() if key != "card"}
    card = mapping["card"]
    if isinstance(card, str):
        try:
            card = json.loads(card)
        except ValueError:
            card = None
    return rest, json_object(card)
