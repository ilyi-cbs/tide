"""Sqlite wiring for conversation state: LangGraph checkpoints plus thread
ownership, on one connection to one file.

`AsyncSqliteSaver.setup()` must run once before first use to create its
tables; `SqliteThreadOwnership.setup()` adds the ownership table.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import aiosqlite
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from agent.adapters.sqlite_threads import SqliteThreadOwnership

# Every custom dataclass that can end up in a checkpoint (state values and
# pending interrupt payloads) must be allowlisted, or LangGraph refuses to
# deserialize it once LANGGRAPH_STRICT_MSGPACK becomes the default.
# tests/test_checkpoint.py checks this list against a real checkpoint.
ALLOWED_MSGPACK_MODULES = (
    ("agent.graph.state", "Budget"),
    ("agent.graph.state", "PendingToolCall"),
    ("agent.graph.state", "ApprovalRequest"),
    ("agent.graph.state", "ExecutionPlan"),
    ("agent.graph.state", "ExecutionOutcome"),
    ("agent.ports.tools", "ToolSpec"),
    ("agent.ports.tools", "ToolFailure"),
)


def serializer() -> JsonPlusSerializer:
    """The checkpoint serializer, with the app's allowlist."""
    return JsonPlusSerializer(allowed_msgpack_modules=ALLOWED_MSGPACK_MODULES)


@asynccontextmanager
async def open_sqlite_store(
    db_path: str,
) -> AsyncIterator[tuple[AsyncSqliteSaver, SqliteThreadOwnership]]:
    directory = os.path.dirname(db_path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    async with aiosqlite.connect(db_path) as conn:
        saver = AsyncSqliteSaver(conn, serde=serializer())
        await saver.setup()
        owners = SqliteThreadOwnership(conn)
        await owners.setup()
        yield saver, owners
