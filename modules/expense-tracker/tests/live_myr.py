#!/usr/bin/env python3
"""Test MYR currency handling — creates test transaction, then cleans it up."""
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
    inserted_ids = []

    orig_exec = r.execute_tool
    async def log_exec(name, args):
        result = await orig_exec(name, args)
        if name == "insert_transaction" and isinstance(result, dict):
            txn_id = result.get("id")
            if txn_id:
                inserted_ids.append({"id": txn_id, "account": args.get("account_id", ""), "desc": args.get("imported_description", "")})
            print(f"  insert_transaction → {json.dumps(result, default=str)[:120]}")
        else:
            budget = args.get("budget_id", "")
            if name in ("fetch_accounts", "fetch_payees", "fetch_categories"):
                count = len(result) if isinstance(result, list) else "?"
                print(f"  {name} → {count} items")
            else:
                val = str(result)[:60]
                print(f"  {name} → {val}")
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
    result = await orch.process_email("myr-test-001", myr_email)
    print(f"\nResult: {json.dumps(result, indent=2)}")

    # --- CLEANUP ---
    if inserted_ids:
        print(f"\n⚠️  Created {len(inserted_ids)} test transaction(s):")
        for txn in inserted_ids:
            print(f"   {txn['id']} — {txn['desc']}")
        print("Run this to clean up from your host:")
        print(f"  curl -X DELETE http://localhost:3000/transactions/ID")
    else:
        print("\n✅ No transactions created — clean.")

    await r.close()

asyncio.run(main())
