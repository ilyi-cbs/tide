from types import SimpleNamespace

import pytest
from langchain_core.messages import HumanMessage

from agent.adapters.fakes import OfflineChatModel
from agent.adapters.litellm_llm import LiteLLMChatModel
from agent.adapters.mcp_tools import McpToolClient
from agent.api.deps import build_llm, build_tool_client
from agent.config import ConfigError, Settings


def _settings(**overrides) -> Settings:
    return Settings(_env_file=None, **overrides)


def test_build_llm_fails_without_model_credentials() -> None:
    with pytest.raises(ConfigError, match="AGENT_MODEL, AGENT_MODEL_API_KEY"):
        build_llm(_settings(agent_model=None, agent_model_api_key=None))


def test_startup_check_names_the_missing_key() -> None:
    with pytest.raises(ConfigError, match="AGENT_MODEL_API_KEY"):
        _settings(agent_model="gpt-4.1").require_runtime_config()


def test_build_llm_uses_real_adapter_with_model_credentials() -> None:
    llm = build_llm(
        _settings(
            agent_model="openai/agent-reasoning",
            agent_model_api_key="configured",
            agent_model_api_base="http://localhost:4000/v1",
        )
    )

    assert isinstance(llm, LiteLLMChatModel)


def test_build_llm_fake_flag_is_the_only_way_to_the_fake_model() -> None:
    llm = build_llm(_settings(llm_fake=True))

    assert isinstance(llm, OfflineChatModel)


def test_fake_llm_still_uses_the_cap_tools(monkeypatch) -> None:
    monkeypatch.setenv("CAP_URL", "http://cap.test:4004/")
    settings = _settings(llm_fake=True)
    client = build_tool_client(settings, "cockpit")
    assert isinstance(client, McpToolClient)
    assert client._url == "http://cap.test:4004/mcp/cockpit"
    assert client._app_id == "cockpit"
    assert client._runtime_url == "http://cap.test:4004/rest/assistant-runtime"


async def test_gateway_stream_preserves_tool_calls_usage_and_route(monkeypatch):
    from agent.adapters import litellm_llm as module

    requests = []

    async def complete(**kwargs):
        requests.append(kwargs)

        async def chunks():
            yield SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        delta=SimpleNamespace(
                            content=None,
                            tool_calls=[
                                SimpleNamespace(
                                    id="call-1",
                                    index=0,
                                    function=SimpleNamespace(name="list_feeds", arguments="{}"),
                                )
                            ],
                        )
                    )
                ],
                usage=None,
            )
            yield SimpleNamespace(
                choices=[],
                usage=SimpleNamespace(prompt_tokens=12, completion_tokens=3, total_tokens=15),
            )

        return chunks()

    monkeypatch.setattr(module.litellm, "acompletion", complete)
    llm = build_llm(
        _settings(
            agent_model="openai/agent-reasoning",
            agent_model_api_key="gateway-secret",
            agent_model_api_base="http://gateway.test/v1",
            turn_timeout_s=7,
        )
    )
    bound = llm.bind_tools(
        [
            {
                "type": "function",
                "function": {
                    "name": "list_feeds",
                    "description": "",
                    "parameters": {"type": "object"},
                },
            }
        ]
    )
    chunks = [chunk async for chunk in bound.astream([HumanMessage(content="list feeds")])]
    combined = chunks[0]
    for chunk in chunks[1:]:
        combined += chunk
    assert combined.tool_calls == [
        {"name": "list_feeds", "args": {}, "id": "call-1", "type": "tool_call"}
    ]
    assert combined.usage_metadata == {"input_tokens": 12, "output_tokens": 3, "total_tokens": 15}
    assert len(requests) == 1
    request = requests[0]
    assert request["model"] == "openai/agent-reasoning"
    assert request["api_base"] == "http://gateway.test/v1"
    assert request["api_key"] == "gateway-secret"
    assert request["timeout"] == 7
    assert request["num_retries"] == 0
    assert request["fallbacks"] == []
    assert request["tools"][0]["function"]["name"] == "list_feeds"
    assert "gateway-secret" not in repr(llm)
    assert "gateway-secret" not in llm.model_dump_json()


@pytest.mark.parametrize("stream", [False, True])
async def test_gateway_failure_does_not_retry_or_fall_back(monkeypatch, stream):
    from agent.adapters import litellm_llm as module

    requests = []

    async def fail(**kwargs):
        requests.append(kwargs)
        raise RuntimeError("gateway unavailable")

    monkeypatch.setattr(module.litellm, "acompletion", fail)
    llm = build_llm(
        _settings(
            agent_model="openai/agent-reasoning",
            agent_model_api_key="configured",
            agent_model_api_base="http://gateway.test/v1",
            turn_timeout_s=7,
        )
    )
    with pytest.raises(RuntimeError, match="gateway unavailable"):
        if stream:
            async for _chunk in llm.astream([HumanMessage(content="go")]):
                pass
        else:
            await llm.ainvoke([HumanMessage(content="go")])
    assert len(requests) == 1
    assert requests[0]["num_retries"] == 0
    assert requests[0]["fallbacks"] == []
