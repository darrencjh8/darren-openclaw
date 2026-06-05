import asyncio
import json
import time
from typing import Any

from openai import AsyncOpenAI

from src.agent.prompts import FEW_SHOT_EXAMPLES, SYSTEM_PROMPT
from src.utils.logging import get_logger


class DeepSeekClient:
    def __init__(self, api_key: str):
        self._client = AsyncOpenAI(
            api_key=api_key,
            base_url="https://api.deepseek.com/v1",
            timeout=30.0,
        )

    async def chat(self, messages: list[dict], tools: list[dict] | None = None, max_tokens: int = 2000) -> Any:
        logger = get_logger("src.agent.deepseek")
        last_error = None

        for attempt in range(3):
            try:
                kwargs = {
                    "model": "deepseek-chat",
                    "messages": messages,
                    "temperature": 0.1,
                    "max_tokens": max_tokens,
                }
                if tools:
                    kwargs["tools"] = tools

                response = await self._client.chat.completions.create(**kwargs)

                usage = response.usage
                if usage:
                    logger.info(
                        "DeepSeek API: attempt=%d, input_tokens=%d, output_tokens=%d",
                        attempt + 1,
                        usage.prompt_tokens,
                        usage.completion_tokens,
                    )
                return response

            except Exception as e:
                last_error = e
                if attempt < 2:
                    wait = 2 ** attempt
                    logger.warning("DeepSeek API attempt %d failed: %s — retrying in %ds", attempt + 1, e, wait)
                    time.sleep(wait)

        raise RuntimeError(f"DeepSeek API failed after 3 attempts: {last_error}")


class AgentOrchestrator:
    def __init__(self, deepseek_client: DeepSeekClient, tool_registry, dedup_journal, memory_store):
        self._llm = deepseek_client
        self._tools = tool_registry
        self._dedup = dedup_journal
        self._memory = memory_store
        self._logger = get_logger("src.agent.orchestrator")
        self._pending: dict | None = None
        self._confirmation_event: asyncio.Event | None = None
        self._confirmation_response: str | None = None

    async def process_event(
        self,
        event_type: str,
        data: bytes | str,
        correlation_id: str = "",
        reply_callback=None,
    ) -> dict:
        self._logger = get_logger("src.agent.orchestrator", correlation_id)
        self._tools.set_telegram_sender(reply_callback)
        self._tools.set_event_context(
            pdf_bytes=data if isinstance(data, bytes) and event_type == "pdf_receipt" else b"",
            raw_email=data if isinstance(data, bytes) and event_type == "email_trade" else b"",
        )

        messages = self._build_messages(event_type, data)
        return await self._run_loop(messages, reply_callback)

    async def _run_loop(self, messages: list[dict], reply_callback=None) -> dict:
        for iteration in range(7):
            response = await self._llm.chat(messages, self._tools.get_tool_schemas())
            choice = response.choices[0]
            message = choice.message

            if message.tool_calls:
                assistant_msg = {"role": "assistant", "content": message.content, "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                    }
                    for tc in message.tool_calls
                ]}
                messages.append(assistant_msg)

                for tc in message.tool_calls:
                    tool_name = tc.function.name
                    try:
                        tool_args = json.loads(tc.function.arguments)
                    except json.JSONDecodeError:
                        tool_args = {}

                    result = await self._tools.execute_tool(tool_name, tool_args)
                    result_parsed = json.loads(result)

                    if isinstance(result_parsed, dict) and result_parsed.get("requires_confirmation"):
                        return await self._handle_confirmation(
                            messages, tc, result_parsed, reply_callback
                        )

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": result,
                    })

            else:
                self._logger.info("Processing complete: %s", message.content)
                return {
                    "action": "completed",
                    "content": message.content,
                    "tool_calls_used": iteration + 1,
                }

        self._logger.warning("Max iterations reached without final decision")
        return {"action": "max_iterations", "content": "Processing limit reached"}

    async def _handle_confirmation(self, messages: list[dict], tc, result: dict, reply_callback) -> dict:
        question = result.get("question", "Proceed?")
        context = result.get("context", "")

        messages.append({
            "role": "tool",
            "tool_call_id": tc.id,
            "content": json.dumps(result),
        })

        self._pending = {
            "question": question,
            "context": context,
            "messages": messages,
            "reply_callback": reply_callback,
        }
        self._confirmation_event = asyncio.Event()
        self._confirmation_response = None

        if reply_callback:
            await reply_callback(f"❓ {question}\n\n{context}\n\nReply: approve / reject")

        try:
            await asyncio.wait_for(self._confirmation_event.wait(), timeout=300.0)
        except asyncio.TimeoutError:
            self._pending = None
            self._confirmation_event = None
            return {"action": "timeout", "content": "User did not respond in time."}

        approved = self._confirmation_response == "approved"
        self._pending = None
        self._confirmation_event = None

        if approved:
            messages.append({
                "role": "user",
                "content": "The user approved. Please proceed with inserting the transactions.",
            })
            return await self._run_loop(messages, reply_callback)
        else:
            messages.append({
                "role": "user",
                "content": "The user rejected. Do NOT insert any transactions. Call log_decision('skipped', 'user rejected').",
            })
            return await self._run_loop(messages, reply_callback)

    def _build_messages(self, event_type: str, data: bytes | str) -> list[dict]:
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]

        for example in FEW_SHOT_EXAMPLES:
            messages.extend(example)

        if event_type == "ibkr_flex_query":
            user_msg = f"Process this IBKR flex query XML:\n\n{data}"
        elif event_type == "pdf_receipt":
            import base64
            pdf_b64 = base64.b64encode(data if isinstance(data, bytes) else data.encode()).decode()
            user_msg = f"Process this PDF receipt (base64):\n{pdf_b64[:50]}...\nCall extract_pdf_text first."
        elif event_type == "email_trade":
            user_msg = "Process this email trade confirmation. Call extract_email_content first."
        elif event_type == "balance_sync":
            user_msg = "Run the daily balance sync: fetch Actual Budget categories and update PP balances."
        elif event_type == "taxonomy_export":
            user_msg = "Run the daily taxonomy export to Google Sheets."
        else:
            user_msg = str(data)

        messages.append({"role": "user", "content": user_msg})
        return messages

    def has_pending_confirmation(self) -> bool:
        return self._pending is not None

    def handle_user_response(self, user_text: str) -> str | None:
        if not self._pending:
            return None
        lower = user_text.strip().lower()
        if lower in ("yes", "approve", "ok", "go ahead", "proceed", "confirm"):
            self._confirmation_response = "approved"
            if self._confirmation_event:
                self._confirmation_event.set()
            return "approved"
        elif lower in ("no", "cancel", "stop", "skip", "reject"):
            self._confirmation_response = "rejected"
            if self._confirmation_event:
                self._confirmation_event.set()
            return "rejected"
        return None
