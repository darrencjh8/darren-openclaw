"""StatementProcessor — LLM conversation loop for credit card statement reconciliation."""

import json
import asyncio
import logging
from typing import Callable

from openai import AsyncOpenAI

from src.config import Config
from src.statement.prompts import STATEMENT_PROMPT, STATEMENT_FEW_SHOT
from src.agent.tools import ToolRegistry

logger = logging.getLogger(__name__)

MAX_TOOL_ITERATIONS = 20


class DeepSeekClient:
    """Thin wrapper around OpenAI-compatible DeepSeek API with configurable model."""

    def __init__(self, config: Config, model: str = "deepseek-chat"):
        self._client = AsyncOpenAI(
            api_key=config.deepseek_api_key,
            base_url="https://api.deepseek.com/v1",
        )
        self._model = model

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
                    timeout=30,
                )
                return response.model_dump()
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


class StatementProcessor:
    """Orchestrates the LLM conversation loop for processing bank statements.

    Uses deepseek-v4-pro (stronger model) for the multi-step reconciliation
    loop. Always marks the email as read and notifies the user on completion
    or failure.
    """

    def __init__(self, config: Config, tools: ToolRegistry | None = None):
        self._config = config
        self._llm = DeepSeekClient(config, model="deepseek-v4-pro")
        self._tools = tools or ToolRegistry(config)

    @property
    def tools(self):
        return self._tools

    async def process_statement(self, msg_id: str, raw_email: bytes, imap_handler=None) -> dict:
        """Process a statement email through LLM reconciliation.

        Extracts PDF/text content, runs LLM tool-calling loop for
        reconciliation, and always marks the email as read.

        Args:
            msg_id: IMAP message ID.
            raw_email: Raw MIME bytes of the email.
            imap_handler: Optional ImapIdleHandler for mark_email_read.

        Returns:
            dict with keys: action, matched_count, outlier_count, details
        """
        from src.extractors import extract_email_content
        import email as em

        self._tools.set_email_context(msg_id, raw_email, imap_handler)

        try:
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
                    return {"action": "error", "details": f"Unexpected finish: {finish_reason}"}

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
                    logger.info("Statement tool %s(%s) → %s", name, arguments, str(result)[:200])

            return {"action": "error", "details": "Max tool iterations exceeded"}

        except Exception as e:
            logger.error("Statement processing failed: %s", e, exc_info=True)
            try:
                if self._tools._imap_handler:
                    await self._tools.execute_tool("mark_email_read", {})
            except Exception:
                pass
            try:
                await self._tools.execute_tool("notify_user", {
                    "message": f"Failed processing statement: {str(e)[:200]}",
                })
            except Exception:
                pass
            return {"action": "error", "details": str(e)[:500]}

    def _build_messages(self, statement_content: str) -> list[dict]:
        messages = [{"role": "system", "content": STATEMENT_PROMPT}]
        for example in STATEMENT_FEW_SHOT:
            messages.extend(example)
        messages.append({
            "role": "user",
            "content": f"Process this credit card statement:\n\n{statement_content[:60000]}",
        })
        return messages
