"""Port for the reasoning LLM.

The graph depends only on `LLMPort`, never on litellm directly (hexagonal
architecture), so tests swap in a scripted fake without patching anything.
Uses LangChain's `BaseChatModel` interface directly as the port: it is the
richest common contract (message history in, streamed `AIMessageChunk`s out,
tool binding) and both the litellm adapter and the fake implement it, so no
extra wrapper type is needed.
"""

from __future__ import annotations

from langchain_core.language_models.chat_models import BaseChatModel

LLMPort = BaseChatModel
