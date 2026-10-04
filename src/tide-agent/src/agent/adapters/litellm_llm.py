"""litellm-backed chat model implementing `agent.ports.llm.LLMPort`.

`Runnable.bind` forwards tool definitions into each completion call.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from typing import Any, cast

import litellm
from langchain_core.callbacks import AsyncCallbackManagerForLLMRun, CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    convert_to_openai_messages,
)
from langchain_core.messages.ai import UsageMetadata
from langchain_core.messages.tool import ToolCallChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.runnables import Runnable
from langchain_core.tools import BaseTool
from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import Field

from agent.api.logging import correlation_id


def _usage(response_usage: Any) -> UsageMetadata | None:
    if response_usage is None:
        return None
    return UsageMetadata(
        input_tokens=response_usage.prompt_tokens,
        output_tokens=response_usage.completion_tokens,
        total_tokens=response_usage.total_tokens,
    )


class LiteLLMChatModel(BaseChatModel):
    """`agent.ports.llm.LLMPort` implementation backed by litellm.

    `api_base`/`api_version` are required for Azure-routed models: Azure OpenAI
    (`azure/<deployment>`, reads AZURE_API_BASE-shaped values) and Azure AI
    Foundry/Anthropic (`azure_ai/<model>`, e.g. `azure_ai/claude-sonnet-5`) both
    need an explicit `api_base`, and Azure OpenAI additionally needs
    `api_version`; litellm has no other way to infer either for these routes.
    """

    model: str
    api_key: str | None = Field(default=None, repr=False, exclude=True)
    api_base: str | None = None
    api_version: str | None = None
    timeout: float | None = None

    @property
    def _llm_type(self) -> str:
        return "litellm"

    def bind_tools(
        self,
        tools: Sequence[dict[str, Any] | type[Any] | Callable[..., Any] | BaseTool],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable[Any, AIMessage]:
        formatted = [convert_to_openai_tool(t) for t in tools]
        if tool_choice is not None:
            kwargs["tool_choice"] = tool_choice
        return self.bind(tools=formatted, **kwargs)

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        raise NotImplementedError("LiteLLMChatModel is async-only; use ainvoke/astream.")

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        payload = convert_to_openai_messages(messages)
        completion = cast(Callable[..., Awaitable[Any]], vars(litellm)["acompletion"])
        response = await completion(
            model=self.model,
            messages=payload,
            api_key=self.api_key,
            api_base=self.api_base,
            api_version=self.api_version,
            timeout=self.timeout,
            stop=stop,
            extra_headers={"X-Correlation-Id": correlation_id.get()},
            **{**kwargs, "num_retries": 0, "fallbacks": []},
        )
        choice: Any = response.choices[0]
        tool_calls: list[Any] = choice.message.tool_calls or []
        message = AIMessage(
            content=choice.message.content or "",
            tool_calls=[
                {
                    "name": tc.function.name,
                    "args": json.loads(tc.function.arguments or "{}"),
                    "id": tc.id,
                }
                for tc in tool_calls
            ],
            usage_metadata=_usage(getattr(response, "usage", None)),
            response_metadata={"alias": self.model, "model": str(response.model)[:256]},
        )
        return ChatResult(generations=[ChatGeneration(message=message)])

    async def _astream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        payload = convert_to_openai_messages(messages)
        completion = cast(Callable[..., Awaitable[Any]], vars(litellm)["acompletion"])
        stream: AsyncIterator[Any] = await completion(
            model=self.model,
            messages=payload,
            api_key=self.api_key,
            api_base=self.api_base,
            api_version=self.api_version,
            timeout=self.timeout,
            stop=stop,
            extra_headers={"X-Correlation-Id": correlation_id.get()},
            stream=True,
            **{
                **kwargs,
                "num_retries": 0,
                "fallbacks": [],
                "stream_options": {"include_usage": True},
            },
        )
        provenance_emitted = False
        async for chunk in stream:
            usage = _usage(getattr(chunk, "usage", None))
            if not chunk.choices:
                if usage is not None:
                    yield ChatGenerationChunk(
                        message=AIMessageChunk(content="", usage_metadata=usage)
                    )
                continue
            delta: Any = chunk.choices[0].delta
            calls: list[Any] = delta.tool_calls or []
            tool_call_chunks: list[ToolCallChunk] = [
                {
                    "name": tc.function.name if tc.function else None,
                    "args": tc.function.arguments if tc.function else None,
                    "id": tc.id,
                    "index": tc.index,
                }
                for tc in calls
            ]
            message_chunk = AIMessageChunk(
                content=delta.content or "",
                tool_call_chunks=tool_call_chunks,
                usage_metadata=usage,
                response_metadata={}
                if provenance_emitted
                else {
                    "alias": self.model,
                    "model": str(getattr(chunk, "model", ""))[:256],
                },
            )
            provenance_emitted = True
            yield ChatGenerationChunk(message=message_chunk)
