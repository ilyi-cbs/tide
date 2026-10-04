from __future__ import annotations

import hmac
import os

from fastapi import HTTPException, Request
from litellm.proxy._types import UserAPIKeyAuth


async def authenticate(request: Request, api_key: str) -> UserAPIKeyAuth:
    agent_key = os.environ.get("GATEWAY_AGENT_KEY", "")
    cap_key = os.environ.get("GATEWAY_CAP_KEY", "")
    if not agent_key or not cap_key or agent_key == cap_key:
        raise HTTPException(status_code=503, detail="Gateway caller configuration unavailable")
    caller = None
    for name, expected in (("agent", agent_key), ("cap", cap_key)):
        if api_key and hmac.compare_digest(api_key, expected):
            caller = name
    if caller is None:
        raise HTTPException(status_code=401, detail="Invalid gateway caller")
    if request.url.path not in ("/chat/completions", "/v1/chat/completions"):
        raise HTTPException(status_code=403, detail="Gateway operation not permitted")
    payload = await request.json()
    if caller != "agent" or payload.get("model") != "agent-reasoning":
        raise HTTPException(status_code=403, detail="Gateway alias not permitted")
    return UserAPIKeyAuth(user_id=caller, key_alias=f"tide-{caller}")
