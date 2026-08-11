/**
 * Tests for MCP server Zod schemas — budget_id .min(1) enforcement.
 */
import { describe, test, expect } from "vitest";
import { z } from "zod";

// Replicate the Zod schemas from mcp-server.js for testing
const schemas = {
    fetch_context: z.object({ budget_id: z.string().min(1) }),
    fetch_recent_transactions: z.object({
        budget_id: z.string().min(1),
        id: z.string().optional(),
        account_id: z.string().optional(),
        days: z.number().optional().default(30),
    }),
    insert_transaction: z.object({
        budget_id: z.string().min(1),
        account_id: z.string().min(1),
        date: z.string().min(1),
        amount_cents: z.number().int(),
        imported_description: z.string().optional(),
        category_id: z.string().optional(),
        notes: z.string().optional(),
    }),
    update_transaction: z.object({
        id: z.string().min(1),
        budget_id: z.string().min(1),
        payee_name: z.string().optional(),
        notes: z.string().optional(),
        amount: z.number().optional(),
        date: z.string().optional(),
        category_id: z.string().optional(),
        account_id: z.string().optional(),
    }),
    resolve_merchant: z.object({
        merchant: z.string().min(1),
        budget_id: z.string().min(1),
    }),
    reconcile_transaction: z.object({
        ab_transaction_ids: z.array(z.string().min(1)).min(1),
        statement_ref: z.string().optional().default(""),
        budget_id: z.string().min(1),
    }),
    unclear_transaction: z.object({
        ab_transaction_ids: z.array(z.string().min(1)).min(1),
        budget_id: z.string().min(1),
    }),
    fetch_unreconciled_transactions: z.object({
        account_id: z.string().min(1),
        date_from: z.string().min(1),
        date_to: z.string().min(1),
        budget_id: z.string().min(1),
    }),
    list_inbox_emails: z.object({
        limit: z.number().int().min(1).max(500).optional().default(50),
    }),
    read_inbox_email: z.object({
        uid: z.number().int().positive(),
    }),
};

describe("MCP Zod schemas — budget_id rejects empty string", () => {
    describe("fetch_context", () => {
        test("rejects empty budget_id", () => {
            const r = schemas.fetch_context.safeParse({ budget_id: "" });
            expect(r.success).toBe(false);
        });

        test("accepts non-empty budget_id", () => {
            const r = schemas.fetch_context.safeParse({
                budget_id: "My Budget",
            });
            expect(r.success).toBe(true);
        });

        test("rejects missing budget_id", () => {
            const r = schemas.fetch_context.safeParse({});
            expect(r.success).toBe(false);
        });
    });

    describe("fetch_recent_transactions", () => {
        test("rejects empty budget_id", () => {
            const r = schemas.fetch_recent_transactions.safeParse({
                budget_id: "",
            });
            expect(r.success).toBe(false);
        });

        test("accepts valid budget_id with optional id", () => {
            const r = schemas.fetch_recent_transactions.safeParse({
                budget_id: "My Budget",
                id: "txn-42",
            });
            expect(r.success).toBe(true);
            expect(r.data.id).toBe("txn-42");
        });

        test("accepts budget_id without id", () => {
            const r = schemas.fetch_recent_transactions.safeParse({
                budget_id: "My Budget",
            });
            expect(r.success).toBe(true);
        });
    });

    describe("insert_transaction", () => {
        test("rejects empty budget_id", () => {
            const r = schemas.insert_transaction.safeParse({
                budget_id: "",
                account_id: "acc-1",
                date: "2026-06-17",
                amount_cents: -425,
            });
            expect(r.success).toBe(false);
        });

        test("rejects empty account_id", () => {
            const r = schemas.insert_transaction.safeParse({
                budget_id: "My Budget",
                account_id: "",
                date: "2026-06-17",
                amount_cents: -425,
            });
            expect(r.success).toBe(false);
        });

        test("rejects empty date", () => {
            const r = schemas.insert_transaction.safeParse({
                budget_id: "My Budget",
                account_id: "acc-1",
                date: "",
                amount_cents: -425,
            });
            expect(r.success).toBe(false);
        });

        test("accepts valid full payload", () => {
            const r = schemas.insert_transaction.safeParse({
                budget_id: "My Budget",
                account_id: "acc-1",
                date: "2026-06-17",
                amount_cents: -1280,
                imported_description: "Toast Box",
                category_id: "cat-food",
                notes: "Lunch",
            });
            expect(r.success).toBe(true);
        });

        test("accepts minimum required fields", () => {
            const r = schemas.insert_transaction.safeParse({
                budget_id: "My Budget",
                account_id: "acc-1",
                date: "2026-06-17",
                amount_cents: -500,
            });
            expect(r.success).toBe(true);
        });
    });

    describe("update_transaction", () => {
        test("rejects empty budget_id", () => {
            const r = schemas.update_transaction.safeParse({
                id: "txn-1",
                budget_id: "",
            });
            expect(r.success).toBe(false);
        });

        test("rejects empty id", () => {
            const r = schemas.update_transaction.safeParse({
                id: "",
                budget_id: "My Budget",
            });
            expect(r.success).toBe(false);
        });

        test("accepts valid minimum payload", () => {
            const r = schemas.update_transaction.safeParse({
                id: "txn-1",
                budget_id: "My Budget",
            });
            expect(r.success).toBe(true);
        });
    });

    describe("resolve_merchant", () => {
        test("rejects empty budget_id", () => {
            const r = schemas.resolve_merchant.safeParse({
                merchant: "Toast Box",
                budget_id: "",
            });
            expect(r.success).toBe(false);
        });

        test("rejects empty merchant", () => {
            const r = schemas.resolve_merchant.safeParse({
                merchant: "",
                budget_id: "My Budget",
            });
            expect(r.success).toBe(false);
        });

        test("accepts valid payload", () => {
            const r = schemas.resolve_merchant.safeParse({
                merchant: "Toast Box",
                budget_id: "My Budget",
            });
            expect(r.success).toBe(true);
        });
    });

    describe("reconcile_transaction", () => {
        test("rejects empty ab_transaction_ids array", () => {
            const r = schemas.reconcile_transaction.safeParse({
                ab_transaction_ids: [],
                budget_id: "My Budget",
            });
            expect(r.success).toBe(false);
        });

        test("rejects empty budget_id", () => {
            const r = schemas.reconcile_transaction.safeParse({
                ab_transaction_ids: ["txn-1"],
                budget_id: "",
            });
            expect(r.success).toBe(false);
        });

        test("accepts single ID in array", () => {
            const r = schemas.reconcile_transaction.safeParse({
                ab_transaction_ids: ["txn-1"],
                budget_id: "My Budget",
            });
            expect(r.success).toBe(true);
            expect(r.data.ab_transaction_ids).toEqual(["txn-1"]);
            expect(r.data.statement_ref).toBe("");
        });

        test("accepts multiple IDs with statement_ref", () => {
            const r = schemas.reconcile_transaction.safeParse({
                ab_transaction_ids: ["txn-1", "txn-2", "txn-3"],
                budget_id: "My Budget",
                statement_ref: "Affin Jun 2026",
            });
            expect(r.success).toBe(true);
            expect(r.data.ab_transaction_ids.length).toBe(3);
            expect(r.data.statement_ref).toBe("Affin Jun 2026");
        });
    });

    describe("unclear_transaction", () => {
        test("rejects empty ab_transaction_ids array", () => {
            const r = schemas.unclear_transaction.safeParse({
                ab_transaction_ids: [],
                budget_id: "My Budget",
            });
            expect(r.success).toBe(false);
        });

        test("rejects empty budget_id", () => {
            const r = schemas.unclear_transaction.safeParse({
                ab_transaction_ids: ["txn-1"],
                budget_id: "",
            });
            expect(r.success).toBe(false);
        });

        test("accepts single ID in array", () => {
            const r = schemas.unclear_transaction.safeParse({
                ab_transaction_ids: ["txn-1"],
                budget_id: "My Budget",
            });
            expect(r.success).toBe(true);
            expect(r.data.ab_transaction_ids).toEqual(["txn-1"]);
        });

        test("accepts multiple IDs", () => {
            const r = schemas.unclear_transaction.safeParse({
                ab_transaction_ids: ["txn-1", "txn-2", "txn-3"],
                budget_id: "My Budget",
            });
            expect(r.success).toBe(true);
            expect(r.data.ab_transaction_ids.length).toBe(3);
        });
    });

    describe("fetch_unreconciled_transactions", () => {
        test("rejects empty account_id", () => {
            const r = schemas.fetch_unreconciled_transactions.safeParse({
                account_id: "",
                date_from: "2026-06-01",
                date_to: "2026-06-30",
                budget_id: "My Budget",
            });
            expect(r.success).toBe(false);
        });

        test("rejects empty date_from", () => {
            const r = schemas.fetch_unreconciled_transactions.safeParse({
                account_id: "acc-1",
                date_from: "",
                date_to: "2026-06-30",
                budget_id: "My Budget",
            });
            expect(r.success).toBe(false);
        });

        test("rejects empty budget_id", () => {
            const r = schemas.fetch_unreconciled_transactions.safeParse({
                account_id: "acc-1",
                date_from: "2026-06-01",
                date_to: "2026-06-30",
                budget_id: "",
            });
            expect(r.success).toBe(false);
        });

        test("accepts valid payload", () => {
            const r = schemas.fetch_unreconciled_transactions.safeParse({
                account_id: "acc-1",
                date_from: "2026-06-01",
                date_to: "2026-06-30",
                budget_id: "My Budget",
            });
            expect(r.success).toBe(true);
        });
    });

    describe("list_inbox_emails", () => {
        test("accepts no arguments (uses defaults)", () => {
            const r = schemas.list_inbox_emails.safeParse({});
            expect(r.success).toBe(true);
            expect(r.data.limit).toBe(50);
        });

        test("accepts valid limit", () => {
            const r = schemas.list_inbox_emails.safeParse({ limit: 10 });
            expect(r.success).toBe(true);
            expect(r.data.limit).toBe(10);
        });

        test("rejects non-integer limit", () => {
            const r = schemas.list_inbox_emails.safeParse({ limit: 3.5 });
            expect(r.success).toBe(false);
        });

        test("rejects zero limit", () => {
            const r = schemas.list_inbox_emails.safeParse({ limit: 0 });
            expect(r.success).toBe(false);
        });

        test("rejects negative limit", () => {
            const r = schemas.list_inbox_emails.safeParse({ limit: -1 });
            expect(r.success).toBe(false);
        });

        test("rejects limit over 500", () => {
            const r = schemas.list_inbox_emails.safeParse({ limit: 501 });
            expect(r.success).toBe(false);
        });

        test("accepts limit of 500", () => {
            const r = schemas.list_inbox_emails.safeParse({ limit: 500 });
            expect(r.success).toBe(true);
        });
    });

    describe("read_inbox_email", () => {
        test("rejects missing uid", () => {
            const r = schemas.read_inbox_email.safeParse({});
            expect(r.success).toBe(false);
        });

        test("rejects zero uid", () => {
            const r = schemas.read_inbox_email.safeParse({ uid: 0 });
            expect(r.success).toBe(false);
        });

        test("rejects negative uid", () => {
            const r = schemas.read_inbox_email.safeParse({ uid: -1 });
            expect(r.success).toBe(false);
        });

        test("rejects non-integer uid", () => {
            const r = schemas.read_inbox_email.safeParse({ uid: "abc" });
            expect(r.success).toBe(false);
        });

        test("accepts valid uid", () => {
            const r = schemas.read_inbox_email.safeParse({ uid: 42 });
            expect(r.success).toBe(true);
            expect(r.data.uid).toBe(42);
        });
    });
});
