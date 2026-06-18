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
});
