"""Structured JSON logs with the request's correlation ID on every line.

The ID comes from the caller's `X-Correlation-Id` header (CAP sends it) or is
generated, is echoed back on the response, and is bound to a ContextVar so
every log record emitted while handling the request carries it.
"""

from __future__ import annotations

import contextvars
import json
import logging
import sys
import uuid
from collections.abc import Callable

from starlette.exceptions import HTTPException
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


class BodyLimitMiddleware:
    """Answers 413 in the error envelope before an oversized body is read.

    Checks `Content-Length` and, for chunked uploads, counts bytes as they
    arrive; the limit is read per request so tests can change it.
    """

    def __init__(self, app: ASGIApp, max_bytes: Callable[[], int]) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = self.max_bytes()
        declared = dict(scope["headers"]).get(b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > limit:
            await _too_large(send, limit)
            return
        seen = 0

        async def counting_receive() -> Message:
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:
                    raise _BodyTooLarge(limit)
            return message

        try:
            await self.app(scope, counting_receive, send)
        except _BodyTooLarge:
            await _too_large(send, limit)


class _BodyTooLarge(HTTPException):
    def __init__(self, limit: int) -> None:
        super().__init__(status_code=413, detail=f"request body larger than {limit} bytes")


async def _too_large(send: Send, limit: int) -> None:
    body = json.dumps(
        {
            "error": {
                "code": "LIMIT_EXCEEDED",
                "message": f"request body larger than {limit} bytes",
                "retryable": False,
            }
        }
    ).encode()
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


class CatchAllMiddleware:
    """Innermost guard: unexpected errors become the INTERNAL envelope here,
    inside the correlation middleware, so the response and the log line carry
    the request's correlation ID (Starlette's own 500 handler runs outside
    every user middleware)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, tracking_send)
        except _BodyTooLarge:
            raise
        except Exception:
            logging.getLogger("tabular").exception("unexpected error")
            if started:
                raise
            body = json.dumps(
                {"error": {"code": "INTERNAL", "message": "internal error", "retryable": False}}
            ).encode()
            await send(
                {
                    "type": "http.response.start",
                    "status": 500,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode()),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
