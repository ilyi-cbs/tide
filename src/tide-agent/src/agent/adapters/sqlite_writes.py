from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import asdict

import aiosqlite

from agent.graph.state import PendingToolCall
from agent.ports.tools import ToolCallResult, ToolFailure
from agent.ports.writes import WriteAttempt

log = logging.getLogger("agent.writes")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS write_attempt (
    thread_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    app_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    arguments TEXT NOT NULL,
    result TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (thread_id, call_id)
)
"""


class SqliteWriteAttempts:
    def __init__(self, conn: aiosqlite.Connection) -> None:
        self._conn = conn

    async def setup(self) -> None:
        await self._conn.execute(_SCHEMA)
        await self._conn.commit()

    async def begin(self, thread_id: str, user_id: str, app_id: str, call: PendingToolCall) -> bool:
        arguments = json.dumps(call.args, sort_keys=True, separators=(",", ":"), allow_nan=False)
        cursor = await self._conn.execute(
            "INSERT OR IGNORE INTO write_attempt "
            "(thread_id, call_id, user_id, app_id, tool_name, arguments) VALUES (?, ?, ?, ?, ?, ?)",
            (thread_id, call.id, user_id, app_id, call.name, arguments),
        )
        inserted = cursor.rowcount == 1
        await self._conn.commit()
        async with self._conn.execute(
            "SELECT user_id, app_id, tool_name, arguments FROM write_attempt "
            "WHERE thread_id = ? AND call_id = ?",
            (thread_id, call.id),
        ) as reader:
            row = await reader.fetchone()
        if row != (user_id, app_id, call.name, arguments):
            raise ValueError("write attempt identity or arguments changed")
        log.info(
            "write attempt retained",
            extra={
                "fields": {
                    "thread_id": thread_id,
                    "call_id": call.id,
                    "tool": call.name,
                    "new": inserted,
                }
            },
        )
        return inserted

    async def finish(
        self,
        thread_id: str,
        user_id: str,
        app_id: str,
        call: PendingToolCall,
        result: ToolCallResult,
    ) -> None:
        arguments = json.dumps(call.args, sort_keys=True, separators=(",", ":"), allow_nan=False)
        encoded = json.dumps(asdict(result), separators=(",", ":"), allow_nan=False)
        cursor = await self._conn.execute(
            "UPDATE write_attempt SET result = ? WHERE thread_id = ? AND call_id = ? "
            "AND user_id = ? AND app_id = ? AND tool_name = ? AND arguments = ?",
            (encoded, thread_id, call.id, user_id, app_id, call.name, arguments),
        )
        await self._conn.commit()
        if cursor.rowcount != 1:
            raise ValueError("write attempt was not owned or did not match")
        log.info(
            "write attempt resolved",
            extra={
                "fields": {
                    "thread_id": thread_id,
                    "call_id": call.id,
                    "tool": call.name,
                    "is_error": result.is_error,
                }
            },
        )

    async def list_attempts(
        self, thread_id: str, user_id: str, app_id: str | None
    ) -> list[WriteAttempt]:
        async with self._conn.execute(
            "SELECT call_id, tool_name, arguments, result FROM write_attempt "
            "WHERE thread_id = ? AND user_id = ? AND (? IS NULL OR app_id = ?) "
            "ORDER BY created_at, call_id",
            (thread_id, user_id, app_id, app_id),
        ) as cursor:
            rows = await cursor.fetchall()
        attempts: list[WriteAttempt] = []
        for call_id, name, arguments, encoded in rows:
            result = json.loads(encoded) if encoded is not None else None
            if result is not None and result.get("error") is not None:
                result["error"] = ToolFailure(**result["error"])
            attempts.append(
                WriteAttempt(
                    PendingToolCall(call_id, name, json.loads(arguments)),
                    ToolCallResult(**result) if result is not None else None,
                )
            )
        return attempts


@asynccontextmanager
async def open_write_journal(db_path: str) -> AsyncIterator[SqliteWriteAttempts]:
    async with aiosqlite.connect(db_path) as conn:
        journal = SqliteWriteAttempts(conn)
        await journal.setup()
        yield journal
