"""Structured JSON logs with the request's correlation ID on every line.

The ID comes from the caller's `X-Correlation-Id` header or is
generated, is echoed back on the response, and is bound to a ContextVar so
every log record emitted while handling the request carries it.
"""

from __future__ import annotations

import contextvars
import json
import logging
import sys
import uuid

from starlette.types import ASGIApp, Message, Receive, Scope, Send

correlation_id: contextvars.ContextVar[str] = contextvars.ContextVar("correlation_id", default="-")

_HEADER = b"x-correlation-id"


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "correlation_id": correlation_id.get(),
            "msg": record.getMessage(),
        }
        entry.update(getattr(record, "fields", {}))
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)


class CorrelationIdMiddleware:
    """Pure ASGI middleware (streaming-safe, unlike BaseHTTPMiddleware)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        incoming = dict(scope["headers"]).get(_HEADER, b"").decode("latin-1")
        cid = incoming[:128] if incoming else str(uuid.uuid4())
        token = correlation_id.set(cid)

        async def send_with_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                message.setdefault("headers", []).append((_HEADER, cid.encode("latin-1")))
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        finally:
            correlation_id.reset(token)
