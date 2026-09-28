/**
 * Regression tests for the two Medium findings from dev-loop code review round 2.
 *
 * M1 — the IBKR flex legs are silent. The sync payload carries four remote legs
 * (pull, flex_pull, flex_import, push) but only pull and push were rendered, so an
 * expired IBKR token produced a log identical to a healthy run. Same defect class
 * as #627, one leg over.
 *
 * M2 — the Actual Budget early return drops the legs entirely. tools.js returns
 * { error, sync_targets } before the payload is assembled, so formatSyncResult got
 * no pull/push keys at all and rendered the empty string. A coincident AB outage
 * plus a dead OneDrive grant made the #627 fix invisible again.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatSyncResult } from "../src/mcp-server.js";
import { ToolRegistry } from "../src/tools.js";

describe("M1 — IBKR flex legs are surfaced", () => {
    it("reports a failed flex_pull even when the OneDrive round trip is healthy", () => {
        // The exact shape _computeSyncAll() builds at tools.js:1064-1070 when
        // pullFlexXml() returns { success: false } and importIbkr is never called.
        const raw = {
            summary: "Synced 3/3 accounts",
            pull: { status: "ok", detail: "downloaded" },
            flex_pull: { success: false, error: "IBKR Flex error 1012: Token has expired" },
            flex_import: null,
            push: { status: "ok", detail: "uploaded" },
            analysis: { message_body: "📊 2026-07-12\n\nLiquid SGD 100,000" },
        };
        const out = formatSyncResult(raw);
        expect(out).toContain("IBKR flex: IBKR Flex error 1012: Token has expired");
        // The healthy OneDrive legs must not be reported as failures.
        expect(out).not.toContain("OneDrive pull");
        expect(out).not.toContain("OneDrive push");
        // The analysis body still renders.
        expect(out).toContain("Liquid SGD 100,000");
    });

    it("reports a failed flex_pull when there is no analysis", () => {
        const raw = {
            summary: "Synced 1/1 accounts",
            pull: { status: "ok", detail: "downloaded" },
            flex_pull: { success: false, error: "Token has expired" },
            push: { status: "ok", detail: "uploaded" },
        };
        const out = formatSyncResult(raw);
        expect(out).toContain("IBKR flex: Token has expired");
    });

    it("leaves a healthy flex leg out of the failure lines", () => {
        // A healthy run must stay byte-identical: flex_pull.success is true, so
        // nothing is prepended. The flex_import summary is already rendered by the
        // existing header, so a successful import adds no error line.
        const raw = {
            summary: "Synced 1/1 accounts",
            pull: { status: "ok", detail: "downloaded" },
            flex_pull: { success: true },
            flex_import: { trades_imported: 3, dividends_imported: 1 },
            push: { status: "ok", detail: "uploaded" },
            analysis: { message_body: "📊 2026-07-12\n\nLiquid SGD 100,000" },
        };
        expect(formatSyncResult(raw)).toBe("📊 2026-07-12\n\nLiquid SGD 100,000");
    });

    it("treats a present flex_import that imported nothing as a failure, not silence", () => {
        // trades_imported is necessarily 0 when the pull failed, so the existing
        // header branch (which requires > 0) can never fire on the failing path.
        // The leg itself is present and did not succeed, so it must be reported.
        const raw = {
            summary: "Synced 1/1 accounts",
            pull: { status: "ok", detail: "downloaded" },
            flex_pull: { success: true },
            flex_import: { status: "error", detail: "import threw", trades_imported: 0, dividends_imported: 0 },
            push: { status: "ok", detail: "uploaded" },
        };
        const out = formatSyncResult(raw);
        expect(out).toContain("IBKR import: import threw");
    });
});

describe("M2 — the AB early return cannot suppress the OneDrive signal", () => {
    it("renders the dead-grant lines when the sync aborted on the AB budget fetch", () => {
        // The real shape from tools.js:954 — reached when fetchBudget() throws, so
        // the payload is never assembled and pull/push are absent entirely.
        const raw = {
            error: "Budget SGD Budget: HTTP 500: boom",
            sync_targets: [
                { name: "Warchest", status: "skipped", delta: 0, error: "OneDrive not synced" },
            ],
        };
        const out = formatSyncResult(raw);
        // The empty string was the defect: the operator saw nothing at all.
        expect(out).not.toBe("");
        // The aborting error itself must be visible, or the cause is lost.
        expect(out).toContain("Budget SGD Budget: HTTP 500: boom");
    });

    it("still reports the OneDrive legs when the payload carries them alongside the abort", () => {
        // Once the early return carries the leg results (the fix in tools.js), a
        // coincident AB outage and a dead grant must both be visible.
        const raw = {
            error: "Budget SGD Budget: HTTP 500: boom",
            sync_targets: [],
            pull: { status: "error", detail: "Token HTTP 400" },
            push: { status: "error", detail: "Token HTTP 400" },
        };
        const out = formatSyncResult(raw);
        expect(out).toContain("⚠️ OneDrive pull: Token HTTP 400");
        expect(out).toContain("⚠️ OneDrive push: Token HTTP 400");
        expect(out).toContain("Budget SGD Budget: HTTP 500: boom");
    });

    it("renders nothing but the abort for a bare { error } with no other detail", () => {
        // The degenerate case the fix must not over-render: no analysis, no legs,
        // no targets. Previously "".
        const out = formatSyncResult({ error: "boom" });
        expect(out).toContain("boom");
    });
});

describe("M2 — the real _computeSyncAll early return carries the legs", () => {
    // The renderer tests above hand-build the payload, so they would still pass if
    // tools.js went back to returning { error, sync_targets }. This drives the real
    // method so the early return itself is covered.

    function makeRegistry(bridge) {
        const cfg = {
            ppXmlPath: "/tmp/does-not-exist.xml",
            ppJarPath: "/tmp/pp-cli.jar",
            ppPassword: "",
            taxonomyNames: ["Regions (Liquid)"],
        };
        const memory = {
            load: () => ({}),
            save: () => {},
            _facts: [],
        };
        const dedup = { check: () => false, record: () => {}, bulkSeed: () => 0 };
        return new ToolRegistry(cfg, dedup, memory, bridge);
    }

    it("returns the leg results alongside the abort reason", async () => {
        const bridge = {
            pull: vi.fn().mockResolvedValue({
                status: "error",
                detail: "Token HTTP 400",
            }),
            push: vi.fn().mockResolvedValue({ status: "ok", detail: "uploaded" }),
            updateBalance: vi.fn().mockResolvedValue({ status: "updated" }),
            getStatus: vi.fn().mockResolvedValue({ summary: {} }),
            queryTaxonomies: vi.fn().mockResolvedValue({ taxonomies: [] }),
        };
        const registry = makeRegistry(bridge);
        // Make the Actual Budget budget fetch throw, which is the aborting path.
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockRejectedValue(new Error("HTTP 500: boom"));
        try {
            const result = await registry._computeSyncAll();
            expect(result.error).toContain("boom");
            // The leg that already ran must survive the abort.
            expect(result.pull).toEqual({
                status: "error",
                detail: "Token HTTP 400",
            });
            expect(result).toHaveProperty("flex_pull");
            expect(result).toHaveProperty("flex_import");
            // And the renderer must now say so.
            const out = formatSyncResult(result);
            expect(out).toContain("OneDrive pull: Token HTTP 400");
            expect(out).toContain("boom");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
