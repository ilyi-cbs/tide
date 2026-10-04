"""Port for thread ownership: every thread belongs to one user in one app."""

from __future__ import annotations

from typing import Protocol


class ThreadNotFound(Exception):
    """The thread doesn't exist for this caller. Deliberately the same error
    whether it belongs to someone else or doesn't exist at all."""


class ThreadOwnershipPort(Protocol):
    async def claim(self, thread_id: str, *, user_id: str, app_id: str) -> None:
        """Record the caller as owner of a new thread, or check they already are.

        Raises `ThreadNotFound` if the thread is owned by another user or app.
        """
        ...

    async def check(self, thread_id: str, *, user_id: str) -> bool:
        """True if the caller owns the thread, False if nobody owns it yet.

        Raises `ThreadNotFound` if another user owns it.
        """
        ...
