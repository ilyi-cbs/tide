"""Verifies callers against CAP (`agent.ports.identity.IdentityPort`).

CAP is the only authority on users and roles, so the agent asks it: an MCP
`initialize` on the agent endpoint with the caller's `Authorization`
header. CAP answers 401 for bad credentials and 403 for users without the
role the agent service requires, so a success proves the caller may use
the tools, before any LLM call is paid for.

The user ID is taken from the header only after CAP has accepted it:

- `Basic` (CAP mocked auth, local dev): the username.
- `Bearer` (JWT): the `user_name` / `sub` claim, read without verifying the
  signature ourselves; the signature was verified by CAP a moment earlier.

Accepted headers are cached briefly (by SHA-256 of the header) so a
reconnecting UI doesn't pay a CAP round trip per request.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import time
from typing import Any, cast

import httpx
from httpx2 import EventSource
from mcp.types import InitializeResult, JSONRPCResponse
from pydantic import ValidationError

from agent.ports.identity import Caller, Forbidden, IdentityUnavailable, Unauthenticated
from agent.ports.tools import json_object

_INITIALIZE: dict[str, Any] = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "tide-agent-auth", "version": "1"},
    },
}


class CapIdentity:
    def __init__(
        self,
        mcp_url: str,
        *,
        timeout_seconds: float = 10.0,
        cache_ttl_seconds: float = 60.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._url = mcp_url
        self._timeout = timeout_seconds
        self._ttl = cache_ttl_seconds
        self._transport = transport
        self._cache: dict[str, tuple[str, float]] = {}
        self._lock = asyncio.Lock()

    async def verify(self, authorization: str | None) -> Caller:
        if not authorization or not authorization.strip():
            raise Unauthenticated("missing Authorization header")
        user_id = user_id_of(authorization)
        key = hashlib.sha256(authorization.encode()).hexdigest()
        now = time.monotonic()
        cached = self._cache.get(key)
        if cached and cached[1] > now:
            return Caller(user_id=cached[0], authorization=authorization)

        await self._ask_cap(authorization)
        async with self._lock:
            self._cache = {k: v for k, v in self._cache.items() if v[1] > now}
            self._cache[key] = (user_id, now + self._ttl)
        return Caller(user_id=user_id, authorization=authorization)

    async def _ask_cap(self, authorization: str) -> None:
        headers = {
            "Authorization": authorization,
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        try:
            async with asyncio.timeout(self._timeout):
                await self._initialize(headers)
        except (httpx.HTTPError, TimeoutError, ValueError, ValidationError) as exc:
            raise IdentityUnavailable(f"CAP initialization failed: {type(exc).__name__}") from exc

    async def _initialize(self, headers: dict[str, str]) -> None:
        async with httpx.AsyncClient(
            timeout=self._timeout, transport=self._transport, follow_redirects=False
        ) as client:
            async with client.stream(
                "POST", self._url, headers=headers, json=_INITIALIZE
            ) as response:
                if response.status_code == 401:
                    raise Unauthenticated("CAP rejected the credentials")
                if response.status_code == 403:
                    raise Forbidden("CAP denies this user the agent's tools")
                if response.status_code != 200:
                    raise IdentityUnavailable(f"CAP answered HTTP {response.status_code}")
                media_type = response.headers.get("content-type", "").split(";")[0].strip()
                if media_type == "text/event-stream":
                    async for event in EventSource(cast(Any, response)):
                        if event.event == "message" and event.data:
                            self._validate_initialization(json.loads(event.data))
                            return
                    raise IdentityUnavailable("CAP initialization stream ended without a result")
                if media_type != "application/json":
                    raise IdentityUnavailable("CAP returned an unexpected initialization format")
                await response.aread()
                self._validate_initialization(response.json())

    @staticmethod
    def _validate_initialization(payload: object) -> None:
        envelope = JSONRPCResponse.model_validate(payload)
        if envelope.id != _INITIALIZE["id"]:
            raise IdentityUnavailable("CAP initialization response ID did not match")
        result = InitializeResult.model_validate(envelope.result)
        if result.protocol_version != _INITIALIZE["params"]["protocolVersion"]:
            raise IdentityUnavailable("CAP initialization negotiated an unsupported protocol")


def user_id_of(authorization: str) -> str:
    """The user ID named by an Authorization header. Raises `Unauthenticated`
    if the header has no recognisable identity."""
    scheme, _, credentials = authorization.strip().partition(" ")
    credentials = credentials.strip()
    if scheme.lower() == "basic":
        try:
            decoded = base64.b64decode(credentials, validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError) as exc:
            raise Unauthenticated("malformed Basic credentials") from exc
        user, sep, _ = decoded.partition(":")
        if not sep or not user:
            raise Unauthenticated("malformed Basic credentials")
        return user
    if scheme.lower() == "bearer":
        parts = credentials.split(".")
        if len(parts) != 3:
            raise Unauthenticated("Bearer token is not a JWT")
        try:
            padded = parts[1] + "=" * (-len(parts[1]) % 4)
            claims = json.loads(base64.urlsafe_b64decode(padded))
        except (binascii.Error, ValueError) as exc:
            raise Unauthenticated("malformed JWT payload") from exc
        payload = json_object(claims)
        user = payload.get("user_name") or payload.get("sub") if payload is not None else None
        if not isinstance(user, str) or not user:
            raise Unauthenticated("JWT names no user")
        return user
    raise Unauthenticated("unsupported Authorization scheme")
