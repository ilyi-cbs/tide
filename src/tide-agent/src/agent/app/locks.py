"""Per-thread pending-input guard.

The lock is process-local; multiple workers require shared coordination.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager


class ThreadBusyError(Exception):
    """Raised when a second request targets a thread that already has one in flight."""


class ThreadLocks:
    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    @asynccontextmanager
    async def acquire(self, thread_id: str) -> AsyncIterator[None]:
        lock = self._locks[thread_id]
        if lock.locked():
            raise ThreadBusyError(thread_id)
        try:
            async with lock:
                yield
        finally:
            if self._locks.get(thread_id) is lock and not lock.locked():
                self._locks.pop(thread_id, None)
