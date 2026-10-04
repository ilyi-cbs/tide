"""FastAPI transport: AG-UI SSE endpoint, thread rehydration, health checks.

Every endpoint except the health checks needs a caller CAP accepts
(`IdentityPort`). Threads belong to the user and app that started them: other
users get 404 on both `/agent` and `/threads/{id}`, the same answer as for a
thread that doesn't exist. Error details are logged with the request's
correlation ID; clients only get a generic message plus that ID.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, nullcontext
from typing import Annotated, Any, cast

from ag_ui.core.events import RunErrorEvent
from ag_ui.core.types import RunAgentInput
from ag_ui.encoder import EventEncoder
from ag_ui_langgraph.utils import langchain_messages_to_agui
from fastapi import Depends, FastAPI, Header, HTTPException, Path, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from agent.adapters.cap_identity import CapIdentity
from agent.adapters.mcp_tools import McpToolClient
from agent.adapters.sqlite_ckpt import open_sqlite_store
from agent.adapters.sqlite_writes import open_write_journal
from agent.api.agui import TideAgent, request_context
from agent.api.deps import (
    build_llm,
    build_request_context,
    build_tool_client,
)
from agent.api.logging import CorrelationIdMiddleware, configure_logging, correlation_id
from agent.app.locks import ThreadBusyError, ThreadLocks
from agent.config import get_settings
from agent.graph.build import build_graph
from agent.graph.nodes import APP_IDS, RETIRED_APP_IDS, restore_write_messages
from agent.ports.identity import (
    Caller,
    Forbidden,
    IdentityPort,
    IdentityUnavailable,
    Unauthenticated,
)
from agent.ports.threads import ThreadNotFound, ThreadOwnershipPort
from agent.ports.tools import json_array, json_object

log = logging.getLogger("agent")

# Thread IDs are client-generated (UUIDs in the assistant); bound their shape.
ThreadId = Annotated[str, Path(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")]
_THREAD_ID_MAX = 128
_TITLE_MAX_LENGTH = 48
_TITLE_INPUT_MAX_LENGTH = 1200


class ThreadTitleRequest(BaseModel):
    text: str = Field(min_length=1, max_length=_TITLE_INPUT_MAX_LENGTH)


class AssistantPageContextInput(BaseModel):
    """Untrusted, bounded UI hint for one turn; never persisted in graph state."""

    model_config = ConfigDict(extra="forbid")

    version: int = Field(ge=1, le=1)
    app: str = Field(pattern=r"^cockpit$")
    surface: str = Field(
        pattern=r"^cockpit\.(overview|delivery-risk-list|delivery-risk-detail|open-item|prevention-list|prevention-case|customer-detail|approvals|requests|planning|proof|help)$"
    )
    entity: AssistantEntityContextInput | None = None
    selection: AssistantSelectionContextInput | None = None
    filters: AssistantFilterContextInput | None = None
    title: str | None = Field(default=None, max_length=120)

    @model_validator(mode="after")
    def validate_bounded_context(self) -> AssistantPageContextInput:
        return self


class AssistantEntityContextInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: str = Field(pattern=r"^(case|finding|purchase-order-item|customer)$")
    id: str = Field(min_length=1, max_length=160)


class AssistantSelectionContextInput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    item_ids: list[str] = Field(alias="itemIds", max_length=20)

    @model_validator(mode="after")
    def validate_item_ids(self) -> AssistantSelectionContextInput:
        if any(not item or len(item) > 32 for item in self.item_ids):
            raise ValueError("invalid page context selection item")
        return self


class AssistantFilterContextInput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    plant: str | None = Field(default=None, max_length=4)
    purchasing_group: str | None = Field(default=None, alias="purchasingGroup", max_length=3)
    supplier: str | None = Field(default=None, max_length=10)


class AssistantRunAgentInput(RunAgentInput):
    """AG-UI input with an optional structured, non-durable page context."""

    page_context: AssistantPageContextInput | None = Field(default=None, alias="pageContext")

    @model_validator(mode="after")
    def validate_messages(self) -> AssistantRunAgentInput:
        settings = get_settings()
        if len(self.messages) > settings.max_input_messages:
            raise ValueError("too many input messages")
        if any(
            len(message.model_dump_json()) > settings.max_message_chars for message in self.messages
        ):
            raise ValueError("input message exceeds the configured size limit")
        return self


class RequestSizeMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") != "POST":
            await self.app(scope, receive, send)
            return
        limit = get_settings().max_request_bytes
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > limit:
                await JSONResponse(
                    {"detail": "request body exceeds the configured size limit"}, status_code=413
                )(scope, receive, send)
                return
            if not message.get("more_body", False):
                break
        delivered = False

        async def replay() -> Message:
            nonlocal delivered
            if delivered:
                return await receive()
            delivered = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, replay, send)


def _short_title(content: object) -> str:
    if isinstance(content, str):
        text = content
    elif (blocks := json_array(content)) is not None:
        text = " ".join(
            str(block.get("text", ""))
            for value in blocks
            if (block := json_object(value)) is not None and isinstance(block.get("text"), str)
        )
    else:
        return ""
    title = " ".join(text.strip().splitlines()[0].split()) if text.strip() else ""
    title = title.strip(" \t\"'`*#")
    if title.lower().startswith("title:"):
        title = title[6:].strip(" \t\"'`*#")
    title = " ".join(title.split()[:6]).rstrip(" ,:;.-")
    if len(title) > _TITLE_MAX_LENGTH:
        title = (title[:_TITLE_MAX_LENGTH].rsplit(" ", 1)[0] or title[:_TITLE_MAX_LENGTH]).rstrip(
            " ,:;.-"
        )
    return title


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    # Fail at startup, not on the first turn, if the LLM isn't configured.
    settings.require_runtime_config()
    async with (
        open_sqlite_store(settings.checkpoint_db) as (checkpointer, owners),
        open_write_journal(settings.checkpoint_db) as writes,
    ):
        graph = build_graph(checkpointer=checkpointer)
        app.state.agent = TideAgent(
            name="agent",
            graph=cast(Any, graph),
            emit_interrupt_outcome=True,
            enable_legacy_on_interrupt_event=False,
        )
        app.state.settings = settings
        app.state.owners = owners
        app.state.writes = writes
        app.state.identity = getattr(app.state, "identity", None) or CapIdentity(
            settings.mcp_url("cockpit"),
            timeout_seconds=settings.mcp_timeout_seconds,
            cache_ttl_seconds=settings.auth_cache_seconds,
        )
        app.state.thread_locks = ThreadLocks()
        app.state.turn_semaphore = asyncio.Semaphore(settings.max_concurrent_turns)
        log.info("agent ready", extra={"fields": {"fake_llm": settings.llm_fake}})
        yield


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type", "X-Tide-App-Id", "X-Correlation-Id"],
    expose_headers=["X-Correlation-Id"],
)
# Outermost, so the ID is set before anything else (CORS included) runs.
app.add_middleware(RequestSizeMiddleware)
app.add_middleware(CorrelationIdMiddleware)


async def current_caller(request: Request) -> Caller:
    identity: IdentityPort = request.app.state.identity
    try:
        return await identity.verify(request.headers.get("authorization"))
    except Unauthenticated as exc:
        log.info("rejected caller", extra={"fields": {"reason": str(exc)}})
        raise HTTPException(
            status_code=401,
            detail="authentication required",
            headers={"WWW-Authenticate": 'Basic realm="tide"'},
        ) from exc
    except Forbidden as exc:
        raise HTTPException(status_code=403, detail="not allowed to use the assistant") from exc
    except IdentityUnavailable as exc:
        log.warning("cannot verify caller", extra={"fields": {"reason": str(exc)}})
        raise HTTPException(status_code=503, detail="authentication service unavailable") from exc


CurrentCaller = Annotated[Caller, Depends(current_caller)]


@app.post("/agent")
async def run_agent(
    input_data: AssistantRunAgentInput,
    request: Request,
    caller: CurrentCaller,
    app_id: Annotated[str | None, Header(alias="x-tide-app-id")] = None,
) -> StreamingResponse:
    settings = request.app.state.settings
    owners: ThreadOwnershipPort = request.app.state.owners
    thread_locks: ThreadLocks = request.app.state.thread_locks
    turn_semaphore: asyncio.Semaphore = request.app.state.turn_semaphore
    encoder = EventEncoder(accept=request.headers.get("accept", "text/event-stream"))

    assistant_app = _require_app(app_id)
    if input_data.page_context and input_data.page_context.app != assistant_app:
        raise HTTPException(status_code=400, detail="page context app does not match assistant app")
    thread_id = input_data.thread_id
    if (
        not thread_id
        or len(thread_id) > _THREAD_ID_MAX
        or not all(char.isascii() and (char.isalnum() or char in "_.:-") for char in thread_id)
    ):
        raise HTTPException(status_code=400, detail="invalid thread id")
    try:
        await owners.claim(thread_id, user_id=caller.user_id, app_id=assistant_app)
    except ThreadNotFound as exc:
        log.warning(
            "thread owned by another user or app",
            extra={"fields": {"thread_id": thread_id, "user": caller.user_id}},
        )
        raise HTTPException(status_code=404, detail="thread not found") from exc

    if turn_semaphore.locked():
        raise HTTPException(status_code=429, detail="too many concurrent turns")
    try:
        lock_cm = thread_locks.acquire(thread_id)
        await lock_cm.__aenter__()
    except ThreadBusyError as exc:
        raise HTTPException(
            status_code=409, detail="thread has a turn already in progress"
        ) from exc
    try:
        await _reject_input_while_approval_pending(request, input_data)
    except BaseException:
        await lock_cm.__aexit__(None, None, None)
        raise

    async def event_generator() -> AsyncIterator[str]:
        token = None
        try:
            llm = build_llm(settings)
            tools = build_tool_client(settings, assistant_app)
            tool_scope = (
                tools.turn(authorization=caller.authorization)
                if isinstance(tools, McpToolClient)
                else nullcontext()
            )
            context = build_request_context(
                authorization=caller.authorization,
                app_id=assistant_app,
                settings=settings,
                llm=llm,
                tools=tools,
                write_attempts=request.app.state.writes,
                thread_id=thread_id,
                user_id=caller.user_id,
                page_context=input_data.page_context.model_dump(by_alias=True, exclude_none=True)
                if input_data.page_context
                else None,
            )
            token = request_context.set(context)
            request_agent = request.app.state.agent.clone()
            agent_payload = input_data.model_dump(by_alias=True, exclude_none=True)
            agent_payload.pop("pageContext", None)
            agent_input = RunAgentInput.model_validate(agent_payload)
            async with turn_semaphore:
                async with asyncio.timeout(settings.turn_timeout_s), tool_scope:
                    async for event in request_agent.run(agent_input):
                        if isinstance(event, RunErrorEvent):
                            # The graph's own error message can carry exception
                            # text from any layer; log it, send a generic one.
                            log.error("turn failed", extra={"fields": {"error": event.message}})
                            event = _client_error("the assistant could not finish this turn")
                        yield encoder.encode(event)
        except TimeoutError:
            log.warning("turn timed out", extra={"fields": {"thread_id": thread_id}})
            yield encoder.encode(_client_error("the turn timed out", code="timeout"))
        except Exception:
            log.exception("turn failed", extra={"fields": {"thread_id": thread_id}})
            yield encoder.encode(_client_error("the assistant could not finish this turn"))
        finally:
            if token is not None:
                request_context.reset(token)
            await lock_cm.__aexit__(None, None, None)

    return StreamingResponse(event_generator(), media_type=encoder.get_content_type())


def _client_error(message: str, *, code: str = "run_error") -> RunErrorEvent:
    return RunErrorEvent(message=f"{message} (ref {correlation_id.get()})", code=code)


def _require_app(app_id: str | None) -> str:
    if app_id in RETIRED_APP_IDS:
        raise HTTPException(status_code=410, detail="assistant app retired")
    if app_id is None or app_id not in APP_IDS:
        raise HTTPException(status_code=400, detail="unknown or missing assistant app id")
    return app_id


async def _reject_input_while_approval_pending(request: Request, input_data: RunAgentInput) -> None:
    """A thread waiting for an approval accepts only the decision (`resume`).

    Checked under the thread lock, so no turn can open or close an approval
    between this check and the run. New messages get 409 and the client
    must decide first; the graph's dangling-call repair is only a fallback.
    """
    if input_data.resume:
        return
    graph = request.app.state.agent.graph
    snapshot = await graph.aget_state({"configurable": {"thread_id": input_data.thread_id}})
    if snapshot.interrupts:
        raise HTTPException(status_code=409, detail="thread is waiting for an approval decision")


@app.get("/threads/{thread_id}")
async def get_thread(thread_id: ThreadId, request: Request, caller: CurrentCaller) -> JSONResponse:
    """Rebuilds the chat after a page reload from the last checkpoint.

    A thread nobody owns yet (a client-generated ID before its first turn)
    reads as empty; another user's thread is 404.
    """
    owners: ThreadOwnershipPort = request.app.state.owners
    try:
        owned = await owners.check(thread_id, user_id=caller.user_id)
    except ThreadNotFound as exc:
        raise HTTPException(status_code=404, detail="thread not found") from exc
    if not owned:
        return JSONResponse(_thread_body(thread_id, [], None))

    graph = request.app.state.agent.graph
    snapshot = await graph.aget_state({"configurable": {"thread_id": thread_id}})
    values = json_object(snapshot.values) or {}
    messages: list[Any] = json_array(values.get("messages")) or []
    attempts = await request.app.state.writes.list_attempts(thread_id, caller.user_id, None)
    messages = restore_write_messages(
        messages, attempts, request.app.state.settings.max_tool_result_chars
    )
    pending = snapshot.interrupts[0] if snapshot.interrupts else None
    return JSONResponse(_thread_body(thread_id, messages, pending))


@app.post("/threads/{thread_id}/title")
async def create_thread_title(
    thread_id: ThreadId,
    payload: ThreadTitleRequest,
    request: Request,
    caller: CurrentCaller,
    app_id: Annotated[str | None, Header(alias="x-tide-app-id")] = None,
) -> dict[str, str]:
    """Return a short title for an owned thread's first user message."""
    assistant_app = _require_app(app_id)
    owners: ThreadOwnershipPort = request.app.state.owners
    try:
        # The client may request the title concurrently with the first turn.
        # Claiming is idempotent for its owner and rejects another user's ID.
        await owners.claim(thread_id, user_id=caller.user_id, app_id=assistant_app)
    except ThreadNotFound as exc:
        raise HTTPException(status_code=404, detail="thread not found") from exc

    settings = request.app.state.settings
    semaphore: asyncio.Semaphore = request.app.state.turn_semaphore
    if semaphore.locked():
        raise HTTPException(status_code=429, detail="too many concurrent turns")
    llm = build_llm(settings)
    try:
        async with semaphore, asyncio.timeout(5):
            response = await llm.ainvoke(
                [
                    SystemMessage(
                        content=(
                            "Create a concise conversation title from the user's request. "
                            "Return only the title, in the user's language, at most six words "
                            f"and {_TITLE_MAX_LENGTH} characters. No quotes, prefix, "
                            "or ending punctuation."
                        )
                    ),
                    HumanMessage(content=payload.text[:_TITLE_INPUT_MAX_LENGTH]),
                ],
                config={"metadata": {"app_id": app_id, "purpose": "thread_title"}},
                max_tokens=40,
            )
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail="title generation timed out") from exc
    except Exception as exc:
        log.warning("thread title generation failed", extra={"fields": {"thread_id": thread_id}})
        raise HTTPException(status_code=503, detail="title generation unavailable") from exc

    title = _short_title(response.content)
    if not title:
        raise HTTPException(status_code=503, detail="title generation returned no title")
    return {"title": title}


def _thread_body(thread_id: str, messages: list[Any], pending: Any | None) -> dict[str, Any]:
    agui_messages = langchain_messages_to_agui(messages)
    # Result cards (tool message artifacts) are not part of AG-UI messages.
    artifacts: dict[str, Any] = {
        m.tool_call_id: artifact
        for m in messages
        if isinstance(m, ToolMessage) and (artifact := json_object(m.artifact)) is not None
    }
    return {
        "thread_id": thread_id,
        "messages": [m.model_dump(by_alias=True) for m in agui_messages],
        "artifacts": artifacts,
        "pending_interrupt": bool(pending),
        "interrupt": {"id": pending.id, "value": pending.value} if pending else None,
    }


@app.get("/healthz")
async def healthz() -> dict[str, object]:
    """Liveness, and whether the offline fake model runs."""
    return {"status": "ok", "llm_fake": bool(get_settings().llm_fake)}


@app.get("/readyz")
async def readyz(request: Request, caller: CurrentCaller) -> dict[str, str]:
    """Readiness for this caller: CAP is reachable and accepts them.

    `current_caller` already made that round trip (401/403/503 on failure),
    so no second MCP session is opened here.
    """
    return {"status": "ready", "user": caller.user_id}


def main() -> None:
    import uvicorn

    settings = get_settings()
    configure_logging(settings.log_level)
    uvicorn.run("agent.api.app:app", host=settings.host, port=settings.port, log_config=None)


if __name__ == "__main__":
    main()
