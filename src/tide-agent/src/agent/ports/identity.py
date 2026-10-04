"""Port for verifying who is calling the agent.

The agent keeps no user store: CAP is the authority. An adapter checks the
caller's credentials against CAP and returns the verified `Caller`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Caller:
    """A caller CAP has accepted. `authorization` is forwarded to CAP as-is."""

    user_id: str
    authorization: str


class Unauthenticated(Exception):
    """Missing or invalid credentials (HTTP 401)."""


class Forbidden(Exception):
    """Valid credentials, but CAP denies this user the agent's tools (HTTP 403)."""


class IdentityUnavailable(Exception):
    """CAP could not be asked (HTTP 503)."""


class IdentityPort(Protocol):
    async def verify(self, authorization: str | None) -> Caller: ...
