jest.mock("fs", () => ({ mkdirSync: jest.fn() }));

const mockApp = {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    use: jest.fn(),
    listen: jest.fn(),
};
jest.mock("express", () => {
    const expr = () => mockApp;
    expr.json = jest.fn(() => "json-mw");
    return expr;
});

jest.mock("@actual-app/api", () => ({
    init: jest.fn(),
    getBudgets: jest.fn(),
    downloadBudget: jest.fn(),
    getAccounts: jest.fn(),
    getCategories: jest.fn(),
    getPayees: jest.fn(),
    getTransaction: jest.fn(),
    getTransactions: jest.fn(),
    addTransactions: jest.fn(),
    deleteTransaction: jest.fn(),
    updateTransaction: jest.fn(),
}));

const { getBudgetId, buildTransaction } = require("../server");

describe("getBudgetId", () => {
    test("returns budget_id from query param", () => {
        const req = { query: { budget_id: "abc123" }, body: {} };
        expect(getBudgetId(req)).toBe("abc123");
    });

    test("returns budget_id from body when query is absent", () => {
        const req = { query: {}, body: { budget_id: "body-id" } };
        expect(getBudgetId(req)).toBe("body-id");
    });

    test("query param takes priority over body", () => {
        const req = {
            query: { budget_id: "query-wins" },
            body: { budget_id: "body-loses" },
        };
        expect(getBudgetId(req)).toBe("query-wins");
    });

    test("returns empty string when neither query nor body has budget_id", () => {
        expect(getBudgetId({ query: {}, body: {} })).toBe("");
        expect(getBudgetId({ query: {} })).toBe("");
    });

    test("returns empty string when body is null", () => {
        const req = { query: {}, body: null };
        expect(getBudgetId(req)).toBe("");
    });

    test("returns empty string when body is undefined", () => {
        const req = { query: {} };
        expect(getBudgetId(req)).toBe("");
    });
});

describe("buildTransaction", () => {
    test("constructs transaction with all fields provided", () => {
        const body = {
            account: "acc-1",
            date: "2025-06-01",
            amount: -1280,
            payee_name: "NTUC FairPrice",
            imported_payee: "FAIRPRICE SINGAPORE",
            notes: "Groceries",
            category: "abc-cat-1",
        };
        const txn = buildTransaction(body);
        expect(txn).toEqual({
            account: "acc-1",
            date: "2025-06-01",
            amount: -1280,
            payee_name: "NTUC FairPrice",
            imported_payee: "FAIRPRICE SINGAPORE",
            notes: "Groceries",
            cleared: false,
            category: "abc-cat-1",
        });
    });

    test("uses account_id when account is missing", () => {
        const body = { account_id: "acc-2", amount: 500 };
        const txn = buildTransaction(body);
        expect(txn.account).toBe("acc-2");
    });

    test("account takes priority over account_id", () => {
        const body = { account: "primary", account_id: "fallback" };
        const txn = buildTransaction(body);
        expect(txn.account).toBe("primary");
    });

    test("payee_name falls back to imported_payee", () => {
        const body = { imported_payee: "SHOPEE SINGAPORE" };
        const txn = buildTransaction(body);
        expect(txn.payee_name).toBe("SHOPEE SINGAPORE");
        expect(txn.imported_payee).toBe("SHOPEE SINGAPORE");
    });

    test("imported_payee falls back to payee_name", () => {
        const body = { payee_name: "Grab" };
        const txn = buildTransaction(body);
        expect(txn.payee_name).toBe("Grab");
        expect(txn.imported_payee).toBe("Grab");
    });

    test("payee_name takes priority over imported_payee", () => {
        const body = { payee_name: "Priority", imported_payee: "Fallback" };
        const txn = buildTransaction(body);
        expect(txn.payee_name).toBe("Priority");
        expect(txn.imported_payee).toBe("Fallback");
    });

    test("payee_name is undefined when both payee fields are missing", () => {
        const body = {};
        const txn = buildTransaction(body);
        expect(txn.payee_name).toBeUndefined();
    });

    test("date defaults to today in YYYY-MM-DD format", () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2025-06-15T10:30:00Z"));
        const txn = buildTransaction({});
        expect(txn.date).toBe("2025-06-15");
        jest.useRealTimers();
    });

    test("amount defaults to 0", () => {
        const txn = buildTransaction({});
        expect(txn.amount).toBe(0);
    });

    test("amount 0 is preserved (not replaced despite falsy)", () => {
        const txn = buildTransaction({ amount: 0 });
        expect(txn.amount).toBe(0);
    });

    test("notes defaults to empty string", () => {
        const txn = buildTransaction({});
        expect(txn.notes).toBe("");
    });

    test("cleared is always false", () => {
        const txn = buildTransaction({ amount: 100 });
        expect(txn.cleared).toBe(false);
    });

    test("category is added only when provided", () => {
        expect(buildTransaction({})).not.toHaveProperty("category");
        expect(buildTransaction({ category: "cat-x" })).toHaveProperty(
            "category",
            "cat-x",
        );
    });

    test("category is not added when it is an empty string (falsy)", () => {
        const txn = buildTransaction({ category: "" });
        expect(txn).not.toHaveProperty("category");
    });

    test("empty body produces valid defaults", () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        const txn = buildTransaction({});
        expect(txn).toEqual({
            account: undefined,
            date: "2025-01-01",
            amount: 0,
            payee_name: undefined,
            imported_payee: undefined,
            notes: "",
            cleared: false,
        });
        jest.useRealTimers();
    });
});

describe("Route handlers", () => {
    const actual = require("@actual-app/api");

    function findHandler(method, path) {
        const call = mockApp[method].mock.calls.find(([p]) => p === path);
        return call ? call[1] : null;
    }

    function mockReq(overrides = {}) {
        return { query: {}, body: null, params: {}, ...overrides };
    }

    function mockRes() {
        return {
            json: jest.fn().mockReturnThis(),
            status: jest.fn().mockReturnThis(),
        };
    }

    beforeEach(() => {
        actual.init.mockReset();
        actual.getBudgets.mockReset();
        actual.downloadBudget.mockReset();
        actual.getTransactions.mockReset();
        actual.getTransaction.mockReset();
        actual.updateTransaction.mockReset();
        actual.addTransactions.mockReset();
        actual.deleteTransaction.mockReset();

        actual.init.mockResolvedValue(undefined);
        actual.getBudgets.mockResolvedValue([
            { name: "TestBudget", groupId: "g1" },
        ]);
        actual.downloadBudget.mockResolvedValue(undefined);
        actual.getTransaction.mockResolvedValue(null);
        actual.getTransactions.mockResolvedValue([]);
        actual.updateTransaction.mockResolvedValue(undefined);
        actual.addTransactions.mockResolvedValue(["txn-new"]);
        actual.deleteTransaction.mockResolvedValue(undefined);
    });

    test("GET /health returns { status: 'ok' }", () => {
        const handler = findHandler("get", "/health");
        const req = mockReq();
        const res = mockRes();
        handler(req, res);
        expect(res.json).toHaveBeenCalledWith({ status: "ok" });
    });

    test("GET /transactions filters out cleared when cleared=false", async () => {
        actual.getTransactions.mockResolvedValue([
            { id: "1", cleared: false, amount: 100 },
            { id: "2", cleared: true, amount: 200 },
            { id: "3", cleared: false, amount: 300 },
        ]);
        const handler = findHandler("get", "/transactions");
        const req = mockReq({
            query: { cleared: "false", account_id: "acc1" },
        });
        const res = mockRes();

        await handler(req, res);

        expect(res.json).toHaveBeenCalledWith([
            { id: "1", cleared: false, amount: 100 },
            { id: "3", cleared: false, amount: 300 },
        ]);
    });

    test("GET /transactions returns all when cleared is not 'false'", async () => {
        actual.getTransactions.mockResolvedValue([
            { id: "1", cleared: false, amount: 100 },
            { id: "2", cleared: true, amount: 200 },
        ]);
        const handler = findHandler("get", "/transactions");
        const req = mockReq({ query: { account_id: "acc1" } });
        const res = mockRes();

        await handler(req, res);

        expect(res.json).toHaveBeenCalledWith([
            { id: "1", cleared: false, amount: 100 },
            { id: "2", cleared: true, amount: 200 },
        ]);
    });

    test("POST /transactions/:id/clear fetches txn, appends notes, sets cleared", async () => {
        actual.getTransaction.mockResolvedValue({
            id: "txn-2",
            account: "acc-1",
            date: "2025-06-01",
            amount: -1280,
            payee: "NTUC",
            notes: "Imported from OCBC alert",
            cleared: false,
        });
        const handler = findHandler("post", "/transactions/:id/clear");
        const req = mockReq({
            params: { id: "txn-2" },
            body: { notes: "Statement May 2026" },
        });
        const res = mockRes();

        await handler(req, res);

        expect(actual.getTransaction).toHaveBeenCalledWith("txn-2");
        expect(actual.updateTransaction).toHaveBeenCalledWith("txn-2", {
            cleared: true,
            notes: "Imported from OCBC alert | Statement May 2026",
        });
        expect(res.json).toHaveBeenCalledWith({
            status: "cleared",
            id: "txn-2",
        });
    });

    test("POST /transactions/:id/clear appends to empty notes", async () => {
        actual.getTransaction.mockResolvedValue({
            id: "txn-3",
            notes: "",
            cleared: false,
        });
        const handler = findHandler("post", "/transactions/:id/clear");
        const req = mockReq({
            params: { id: "txn-3" },
            body: { notes: "Statement Jun 2026" },
        });
        const res = mockRes();

        await handler(req, res);

        expect(actual.updateTransaction).toHaveBeenCalledWith("txn-3", {
            cleared: true,
            notes: " | Statement Jun 2026",
        });
    });

    test("POST /transactions/:id/clear returns 404 when txn not found", async () => {
        actual.getTransaction.mockResolvedValue(null);
        const handler = findHandler("post", "/transactions/:id/clear");
        const req = mockReq({ params: { id: "nonexistent" } });
        const res = mockRes();

        await handler(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({
            error: "Transaction not found",
        });
        expect(actual.updateTransaction).not.toHaveBeenCalled();
    });

    test("route error returns 500 with error.message in JSON body", async () => {
        actual.getTransactions.mockRejectedValue(
            new Error("DB connection failed"),
        );
        const handler = findHandler("get", "/transactions");
        const req = mockReq();
        const res = mockRes();

        await handler(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            error: "DB connection failed",
        });
    });

    test("DELETE /transactions/:id deletes and returns confirmation", async () => {
        actual.deleteTransaction.mockResolvedValue(undefined);
        const handler = findHandler("delete", "/transactions/:id");
        const req = mockReq({ params: { id: "del-1" } });
        const res = mockRes();

        await handler(req, res);

        expect(actual.deleteTransaction).toHaveBeenCalledWith("del-1");
        expect(res.json).toHaveBeenCalledWith({
            status: "deleted",
            id: "del-1",
        });
    });

    describe("PATCH /transactions/:id", () => {
        it("passes partial fields to actual.updateTransaction", async () => {
            const handler = findHandler("patch", "/transactions/:id");
            const req = mockReq({
                params: { id: "txn-5" },
                body: { payee: "Food", notes: "test" },
            });
            const res = mockRes();

            await handler(req, res);

            expect(actual.updateTransaction).toHaveBeenCalledWith("txn-5", {
                payee: "Food",
                notes: "test",
            });
        });

        it("returns { status: 'updated', id } on success", async () => {
            const handler = findHandler("patch", "/transactions/:id");
            const req = mockReq({
                params: { id: "txn-6" },
                body: { payee: "Coffee" },
            });
            const res = mockRes();

            await handler(req, res);

            expect(res.json).toHaveBeenCalledWith({
                status: "updated",
                id: "txn-6",
            });
        });

        it("returns 400 when body has no updatable fields", async () => {
            const handler = findHandler("patch", "/transactions/:id");
            const req = mockReq({
                params: { id: "txn-7" },
                body: {},
            });
            const res = mockRes();

            await handler(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({
                error: "No fields to update",
            });
        });

        it("returns 500 on API error", async () => {
            actual.updateTransaction.mockRejectedValue(
                new Error("Update failed"),
            );
            const handler = findHandler("patch", "/transactions/:id");
            const req = mockReq({
                params: { id: "txn-8" },
                body: { notes: "boom" },
            });
            const res = mockRes();

            await handler(req, res);

            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.json).toHaveBeenCalledWith({
                error: "Update failed",
            });
        });
    });
});
