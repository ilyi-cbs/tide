import base64
import json

import httpx
import pytest

from agent.adapters.cap_identity import CapIdentity, user_id_of
from agent.adapters.sqlite_ckpt import open_sqlite_store
from agent.ports.identity import Forbidden, IdentityUnavailable, Unauthenticated
from agent.ports.threads import ThreadNotFound

URL = "http://cap.test/mcp/cockpit"


def _basic(user: str, password: str = "pw") -> str:
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


def _jwt(claims: dict) -> str:
    def part(obj) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")

    return f"Bearer {part({'alg': 'none'})}.{part(claims)}.sig"


def _cap(status: int, seen: list | None = None) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return httpx.Response(
            status,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "serverInfo": {"name": "cap", "version": "1"},
                },
            },
        )

    return httpx.MockTransport(handler)


@pytest.mark.parametrize(
    ("authorization", "user"),
    [
        (_basic("ilyesse.hettenbach@cbs-consulting.de"), "ilyesse.hettenbach@cbs-consulting.de"),
        (_jwt({"user_name": "u1", "sub": "s1"}), "u1"),
        (_jwt({"sub": "s1"}), "s1"),
    ],
)
def test_user_id_of_known_schemes(authorization, user):
    assert user_id_of(authorization) == user


@pytest.mark.parametrize(
    "authorization",
    [
        "Token abc",
        "Basic !!!",
        _basic(""),
        "Basic " + base64.b64encode(b"nocolon").decode(),
        "Bearer not-a-jwt",
        _jwt({"aud": "x"}),
    ],
)
def test_user_id_of_rejects_unusable_headers(authorization):
    with pytest.raises(Unauthenticated):
        user_id_of(authorization)


async def test_verify_asks_cap_and_forwards_the_header():
    seen: list[httpx.Request] = []
    identity = CapIdentity(URL, transport=_cap(200, seen))
    caller = await identity.verify(_basic("ilyesse.hettenbach@cbs-consulting.de"))
    assert caller.user_id == "ilyesse.hettenbach@cbs-consulting.de"
    assert seen[0].headers["Authorization"] == _basic("ilyesse.hettenbach@cbs-consulting.de")
    assert json.loads(seen[0].content)["method"] == "initialize"


@pytest.mark.parametrize(
    ("status", "error"), [(401, Unauthenticated), (403, Forbidden), (500, IdentityUnavailable)]
)
async def test_verify_maps_cap_answers(status, error):
    with pytest.raises(error):
        await CapIdentity(URL, transport=_cap(status)).verify(
            _basic("ilyesse.hettenbach@cbs-consulting.de")
        )


async def test_verify_rejects_missing_header_without_asking_cap():
    seen: list = []
    with pytest.raises(Unauthenticated):
        await CapIdentity(URL, transport=_cap(200, seen)).verify(None)
    assert seen == []


async def test_verify_reports_unreachable_cap():
    def refuse(request):
        raise httpx.ConnectError("refused")

    with pytest.raises(IdentityUnavailable):
        await CapIdentity(URL, transport=httpx.MockTransport(refuse)).verify(
            _basic("ilyesse.hettenbach@cbs-consulting.de")
        )


async def test_accepted_headers_are_cached_rejected_ones_are_not():
    seen: list = []
    identity = CapIdentity(URL, transport=_cap(200, seen), cache_ttl_seconds=60)
    await identity.verify(_basic("ilyesse.hettenbach@cbs-consulting.de"))
    await identity.verify(_basic("ilyesse.hettenbach@cbs-consulting.de"))
    assert len(seen) == 1

    rejecting = CapIdentity(URL, transport=_cap(401, seen := []))
    for _ in range(2):
        with pytest.raises(Unauthenticated):
            await rejecting.verify(_basic("ilyesse.hettenbach@cbs-consulting.de", "wrong"))
    assert len(seen) == 2


async def test_zero_ttl_disables_the_cache():
    seen: list = []
    identity = CapIdentity(URL, transport=_cap(200, seen), cache_ttl_seconds=0)
    await identity.verify(_basic("ilyesse.hettenbach@cbs-consulting.de"))
    await identity.verify(_basic("ilyesse.hettenbach@cbs-consulting.de"))
    assert len(seen) == 2


@pytest.mark.parametrize(
    "status,payload",
    [
        (302, {}),
        (200, {}),
        (200, {"jsonrpc": "2.0", "id": 1, "error": {"code": -1}}),
    ],
)
async def test_initialization_must_prove_authentication(status, payload):
    identity = CapIdentity(
        URL, transport=httpx.MockTransport(lambda request: httpx.Response(status, json=payload))
    )
    with pytest.raises(IdentityUnavailable):
        await identity.verify(_basic("alice"))
    assert not identity._cache


async def test_initialization_accepts_valid_sse():
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "serverInfo": {"name": "cap", "version": "1"},
        },
    }
    identity = CapIdentity(
        URL,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                text=f"event: message\ndata: {json.dumps(payload)}\n\n",
            )
        ),
    )
    assert (await identity.verify(_basic("alice"))).user_id == "alice"


async def test_thread_ownership(tmp_path):
    async with open_sqlite_store(str(tmp_path / "c.sqlite")) as (_, owners):
        assert await owners.check("t1", user_id="ilyesse.hettenbach@cbs-consulting.de") is False
        await owners.claim("t1", user_id="ilyesse.hettenbach@cbs-consulting.de", app_id="lead-time")
        await owners.claim(
            "t1", user_id="ilyesse.hettenbach@cbs-consulting.de", app_id="lead-time"
        )  # idempotent
        assert await owners.check("t1", user_id="ilyesse.hettenbach@cbs-consulting.de") is True
        with pytest.raises(ThreadNotFound):
            await owners.check("t1", user_id="bob")
        with pytest.raises(ThreadNotFound):
            await owners.claim("t1", user_id="bob", app_id="lead-time")
        with pytest.raises(ThreadNotFound):
            await owners.claim(
                "t1", user_id="ilyesse.hettenbach@cbs-consulting.de", app_id="tabpfn-playground"
            )


async def test_thread_ownership_survives_a_restart(tmp_path):
    path = str(tmp_path / "c.sqlite")
    async with open_sqlite_store(path) as (_, owners):
        await owners.claim("t1", user_id="ilyesse.hettenbach@cbs-consulting.de", app_id="lead-time")
    async with open_sqlite_store(path) as (_, owners):
        with pytest.raises(ThreadNotFound):
            await owners.check("t1", user_id="bob")
