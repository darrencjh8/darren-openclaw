#!/usr/bin/env python3
"""Test MYR currency handling — synthetic MYR email through orchestrator."""
import asyncio, json, os, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")
from src.config import Config
from src.agent.orchestrator import AgentOrchestrator
from src.agent.tools import ToolRegistry

cfg = Config.from_env()

async def main():
    r = ToolRegistry(cfg)

    orig_exec = r.execute_tool
    async def log_exec(name, args):
        result = await orig_exec(name, args)
        budget = args.get("budget_id", "")
        flag = f" [budget={budget}]" if budget else ""
        if name in ("fetch_accounts", "fetch_payees", "fetch_categories"):
            count = len(result) if isinstance(result, list) else "?"
            print(f"  {name}(budget_id={budget!r}) → {count} items")
        elif name == "insert_transaction":
            print(f"  insert_transaction(budget_id={budget!r}) → {json.dumps(result, default=str)[:120]}")
        elif name == "notify_user":
            msg = args.get("message", str(args)[:80])
            print(f"  notify_user: {msg[:100]}")
        else:
            val = str(result)[:60]
            print(f"  {name}({json.dumps({k: str(v)[:40] for k,v in args.items()}, default=str)[:100]}) → {val}")
        return result
    r.execute_tool = log_exec

    orch = AgentOrchestrator(cfg, tools=r)

    myr_email = (
        b"From: alerts@maybank.com.my\r\n"
        b"Subject: Transaction Alert\r\n"
        b"Date: Thu, 05 Jun 2026 13:00:00 +0800\r\n"
        b"\r\n"
        b"RM 45.50 was charged to your Maybank Visa ending 6789\r\n"
        b"at KFC JALAN SULTAN on 05/06/2026."
    )

    print("--- MYR Test: KFC RM 45.50 ---")
    print(f"Raw: {myr_email.decode()[:200]}")

    result = await orch.process_email("myr-test-001", myr_email)
    print(f"\nResult: {json.dumps(result, indent=2)}")
    await r.close()

asyncio.run(main())
