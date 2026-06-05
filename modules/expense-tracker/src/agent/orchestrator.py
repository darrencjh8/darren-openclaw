"""Agent Orchestrator — LLM conversation loop with tool calling."""

import json
import asyncio
import logging
from typing import Callable

from openai import AsyncOpenAI

from src.config import Config
from src.agent.prompts import SYSTEM_PROMPT, FEW_SHOT_EXAMPLES
from src.agent.tools import ToolRegistry

logger = logging.getLogger(__name__)

MAX_TOOL_ITERATIONS = 5


class DeepSeekClient:
    """Thin wrapper around OpenAI-compatible DeepSeek API."""

    def __init__(self, config: Config):
        self._client = AsyncOpenAI(
            api_key=config.deepseek_api_key,
            base_url="https://api.deepseek.com/v1",
        )
        self._model = "deepseek-chat"

    def _merge_reasoning(self, data: dict) -> None:
        for choice in data.get("choices", []):
            msg = choice.get("message", {})
            if not msg.get("content") and msg.get("reasoning_content"):
                msg["content"] = msg["reasoning_content"]

    async def chat(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        kwargs = {
            "model": self._model,
            "messages": messages,
            "temperature": 0.1,
        }
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

        retry_delays = [1, 2, 4]
        for attempt in range(3):
            try:
                response = await asyncio.wait_for(
                    self._client.chat.completions.create(**kwargs),
                    timeout=60,
                )
                data = response.model_dump()
                self._merge_reasoning(data)
                return data
            except asyncio.TimeoutError:
                if attempt < 2:
                    logger.warning("DeepSeek timeout, retry %d/3", attempt + 2)
                    await asyncio.sleep(retry_delays[attempt])
                else:
                    raise
            except Exception as e:
                if attempt < 2:
                    logger.warning("DeepSeek API error, retry %d/3: %s", attempt + 2, e)
                    await asyncio.sleep(retry_delays[attempt])
                else:
                    raise


class AgentOrchestrator:
    """Orchestrates the LLM conversation loop for processing emails."""

    def __init__(self, config: Config, tools: ToolRegistry | None = None):
        self._config = config
        self._llm = DeepSeekClient(config)
        self._tools = tools or ToolRegistry(config)

    @property
    def tools(self):
        return self._tools

    async def process_email(self, msg_id: str, raw_email: bytes, imap_handler=None) -> dict:
        """Process a single email through the LLM agent pipeline.

        Args:
            msg_id: IMAP message ID.
            raw_email: Raw MIME bytes of the email.
            imap_handler: Optional ImapIdleHandler for mark_email_read.

        Returns:
            dict with keys: action (inserted|skipped|notified|error), details
        """
        from src.extractors import extract_email_content
        import email as em

        self._tools.set_email_context(msg_id, raw_email, imap_handler)

        msg = em.message_from_bytes(raw_email)
        email_text = extract_email_content(msg)

        messages = self._build_messages(email_text)
        tool_schemas = self._tools.get_tool_schemas()

        for iteration in range(MAX_TOOL_ITERATIONS):
            response = await self._llm.chat(messages, tool_schemas)
            choice = response.get("choices", [{}])[0]
            finish_reason = choice.get("finish_reason")
            message = choice.get("message", {})

            if message.get("content"):
                messages.append({"role": "assistant", "content": message["content"]})

            tool_calls = message.get("tool_calls")
            if not tool_calls:
                if finish_reason == "stop":
                    return {"action": "completed", "details": message.get("content", "")}
                return {"action": "error", "details": f"Unexpected finish_reason: {finish_reason}"}

            if tool_calls:
                assistant_msg = {
                    "role": "assistant",
                    "content": message.get("content"),
                    "tool_calls": tool_calls,
                }
                if assistant_msg["content"] is None:
                    del assistant_msg["content"]
                messages.append(assistant_msg)

                for tc in tool_calls:
                    func = tc.get("function", {})
                    name = func.get("name", "")
                    arguments = func.get("arguments", "{}")

                    if isinstance(arguments, str):
                        try:
                            arguments = json.loads(arguments)
                        except json.JSONDecodeError:
                            arguments = {}

                    result = await self._tools.execute_tool(name, arguments)
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.get("id", ""),
                        "content": json.dumps(result) if not isinstance(result, str) else result,
                    })
                    logger.info("Tool %s(%s) → %s", name, arguments, str(result)[:200])

        return {"action": "error", "details": "Max tool iterations exceeded"}

    def _build_messages(self, email_content: str) -> list[dict]:
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        for example in FEW_SHOT_EXAMPLES:
            messages.extend(example)
        messages.append({
            "role": "user",
            "content": f"Process this email:\n\n{email_content}",
        })
        return messages
