"""Thread ownership in sqlite (`agent.ports.threads.ThreadOwnershipPort`).

Stored in its own table next to the LangGraph checkpoints, on the same
connection. The primary key makes the first claim atomic: if two users race
for a new thread ID, exactly one insert wins.
"""

from __future__ import annotations

import aiosqlite

from agent.ports.threads import ThreadNotFound

_SCHEMA = """
CREATE TABLE IF NOT EXISTS thread_owner (
    thread_id  TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    app_id     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""


class SqliteThreadOwnership:
    def __init__(self, conn: aiosqlite.Connection) -> None:
        self._conn = conn

    async def setup(self) -> None:
        await self._conn.execute(_SCHEMA)
        await self._conn.commit()

    async def claim(self, thread_id: str, *, user_id: str, app_id: str) -> None:
        await self._conn.execute(
            "INSERT OR IGNORE INTO thread_owner (thread_id, user_id, app_id) VALUES (?, ?, ?)",
            (thread_id, user_id, app_id),
        )
        await self._conn.commit()
        owner = await self._owner(thread_id)
        if owner != (user_id, app_id):
            raise ThreadNotFound(thread_id)

    async def check(self, thread_id: str, *, user_id: str) -> bool:
        owner = await self._owner(thread_id)
        if owner is None:
            return False
        if owner[0] != user_id:
            raise ThreadNotFound(thread_id)
        return True

    async def _owner(self, thread_id: str) -> tuple[str, str] | None:
        async with self._conn.execute(
            "SELECT user_id, app_id FROM thread_owner WHERE thread_id = ?", (thread_id,)
        ) as cursor:
            row = await cursor.fetchone()
        return (row[0], row[1]) if row else None
