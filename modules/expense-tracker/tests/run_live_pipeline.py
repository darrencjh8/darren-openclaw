#!/usr/bin/env python3
"""Live end-to-end pipeline test: IMAP → extract → DeepSeek → insert → delete.

1. Fetch one unread email from Zoho
2. Run it through AgentOrchestrator with real DeepSeek LLM
3. Capture all tool calls and the LLM's final decision
4. If a transaction was inserted, delete it from Actual Budget
5. Leave the email UNREAD in the inbox
"""

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from src.config import Config
from src.utils.logging import setup_logging
from src.imap.idle_handler import ImapIdleHandler
from src.agent.tools import ToolRegistry
from src.agent.orchestrator import AgentOrchestrator

setup_logging("WARNING")
cfg = Config.from_env()


async def main():
    handler = ImapIdleHandler(
        cfg.imap_host, cfg.imap_port, cfg.imap_username, cfg.imap_password
    )
    await handler.connect()

    unread = await handler.fetch_unread()
    if not unread:
        print("No unread emails in inbox.")
        await handler.disconnect()
        return

    r = unread[0]
    print(f"Email: [{r['msg_id']}] {r['subject']}")
    print(f"From: {r['from']}")
    print()

    registry = ToolRegistry(cfg)

    original_mark_read = handler.mark_read

    async def noop_mark_read(msg_id):
        print(f"  [SKIP] mark_read({msg_id}) — leaving email unread")

    handler.mark_read = noop_mark_read

    tool_log = []

    orig_execute = registry.execute_tool

    async def log_execute(name, args):
        result = await orig_execute(name, args)
        entry = {
            "tool": name,
            "args": {k: str(v)[:80] for k, v in args.items()},
        }
        if name == "fetch_accounts" and isinstance(result, list):
            entry["result"] = f"{len(result)} accounts"
            names = [a.get("name", "?") for a in result[:10]]
            print(f"  [{name}] {len(result)} accounts: {names}")
        elif name == "fetch_categories" and isinstance(result, list):
            entry["result"] = f"{len(result)} categories"
            print(f"  [{name}] {len(result)} categories")
        elif name == "fetch_payees" and isinstance(result, list):
            entry["result"] = f"{len(result)} payees"
            print(f"  [{name}] {len(result)} payees")
        elif name == "insert_transaction":
            entry["result"] = json.dumps(result, default=str)[:200]
            print(f"  [{name}] {json.dumps(result, default=str)}")
        elif name == "notify_user":
            msg = args.get("message", args.get("body", str(args)[:80]))
            print(f"  [notify_user] {msg[:80]}")
            entry["result"] = str(result)
        else:
            entry["result"] = json.dumps(result, default=str)[:100]
            print(f"  [{name}]({json.dumps(args, default=str)[:100]}) → {str(result)[:80]}")
        tool_log.append(entry)
        return result

    registry.execute_tool = log_execute

    orch = AgentOrchestrator(cfg, tools=registry)

    print("--- Running orchestrator ---")
    result = await orch.process_email(r["msg_id"], r["raw_email"], imap_handler=handler)

    print(f"\n=== LLM Decision ===")
    print(json.dumps(result, indent=2))

    inserted = any(t["tool"] == "insert_transaction" for t in tool_log)
    if inserted:
        insert_call = next(t for t in tool_log if t["tool"] == "insert_transaction")
        tx_id = None
        if isinstance(insert_call["result"], str):
            try:
                tx_id = json.loads(insert_call["result"]).get("id")
            except Exception:
                pass

        if tx_id:
            print(f"\nDeleting transaction {tx_id}...")
            try:
                import aiohttp

                api_url = os.environ.get("ACTUAL_API_URL", "http://localhost:3000")
                async with aiohttp.ClientSession() as session:
                    delete_url = f"{api_url}/transactions/{tx_id}"
                    async with session.delete(delete_url) as resp:
                        print(f"  DELETE {delete_url} → {resp.status} {await resp.text()}")
            except Exception as e:
                print(f"  Delete via HTTP failed: {e}")
    else:
        print("\nNo transaction was inserted.")

    handler.mark_read = original_mark_read
    await registry.close()
    await handler.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
