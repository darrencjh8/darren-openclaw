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
    getTransactions: jest.fn(),
    addTransactions: jest.fn(),
    deleteTransaction: jest.fn(),
    updateTransaction: jest.fn(),
    getAccountBalance: jest.fn(),
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
        actual.updateTransaction.mockReset();
        actual.addTransactions.mockReset();
        actual.deleteTransaction.mockReset();

        actual.init.mockResolvedValue(undefined);
        actual.getBudgets.mockResolvedValue([
            { name: "TestBudget", groupId: "g1" },
        ]);
        actual.downloadBudget.mockResolvedValue(undefined);
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

    test("POST /transactions/:id/clear sets cleared directly without getTransaction", async () => {
        const handler = findHandler("post", "/transactions/:id/clear");
        const req = mockReq({
            params: { id: "txn-2" },
            body: { notes: "Statement May 2026" },
        });
        const res = mockRes();

        await handler(req, res);

        expect(actual.updateTransaction).toHaveBeenCalledWith("txn-2", {
            cleared: true,
            notes: "Statement May 2026",
        });
        expect(res.json).toHaveBeenCalledWith({
            status: "cleared",
            id: "txn-2",
        });
    });

    test("POST /transactions/:id/clear clears without notes", async () => {
        const handler = findHandler("post", "/transactions/:id/clear");
        const req = mockReq({
            params: { id: "txn-3" },
            body: {},
        });
        const res = mockRes();

        await handler(req, res);

        expect(actual.updateTransaction).toHaveBeenCalledWith("txn-3", {
            cleared: true,
        });
    });

    test("POST /transactions/:id/unclear sets cleared to false", async () => {
        const handler = findHandler("post", "/transactions/:id/unclear");
        const req = mockReq({
            params: { id: "txn-2" },
            body: {},
        });
        const res = mockRes();

        await handler(req, res);

        expect(actual.updateTransaction).toHaveBeenCalledWith("txn-2", {
            cleared: false,
        });
        expect(res.json).toHaveBeenCalledWith({
            status: "uncleared",
            id: "txn-2",
        });
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

describe("GET /budgets", () => {
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
        actual.init.mockResolvedValue(undefined);
    });

    test("returns formatted budget list", async () => {
        actual.getBudgets.mockResolvedValue([
            { name: "My Budget", groupId: "g1", cloudFileId: "c1" },
            { name: "MYR Budget", groupId: "g2", cloudFileId: null },
        ]);
        const handler = findHandler("get", "/budgets");
        const res = mockRes();

        await handler(mockReq(), res);

        expect(res.json).toHaveBeenCalledWith([
            { name: "My Budget", groupId: "g1", cloudFileId: "c1" },
            { name: "MYR Budget", groupId: "g2", cloudFileId: null },
        ]);
    });

    test("returns 500 on API error", async () => {
        actual.getBudgets.mockRejectedValue(new Error("Boom"));
        const handler = findHandler("get", "/budgets");
        const res = mockRes();

        await handler(mockReq(), res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: "Boom" });
    });
});

describe("GET /transactions/:id", () => {
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
        actual.init.mockResolvedValue(undefined);
    });

    test("returns single transaction by ID", async () => {
        actual.getTransactions.mockResolvedValue([
            { id: "other-transaction" },
            {
                id: "txn-42",
                date: "2026-06-17",
                amount: -1280,
                payee: "Toast Box",
            },
        ]);
        const handler = findHandler("get", "/transactions/:id");
        const res = mockRes();

        await handler(mockReq({ params: { id: "txn-42" } }), res);

        expect(actual.getTransactions).toHaveBeenCalledWith(
            undefined,
            "1970-01-01",
            expect.any(String),
        );
        expect(res.json).toHaveBeenCalledWith({
            id: "txn-42",
            date: "2026-06-17",
            amount: -1280,
            payee: "Toast Box",
        });
    });

    test("returns notes in single transaction by ID (notes transport)", async () => {
        actual.getTransactions.mockResolvedValue([
            {
                id: "txn-43",
                notes: "Merchant: WWW.TADA.G* N01A04E712\nStatement: DBS Yuu | 2026-06-01..2026-06-30\n\nuser note",
            },
        ]);
        const handler = findHandler("get", "/transactions/:id");
        const res = mockRes();

        await handler(mockReq({ params: { id: "txn-43" } }), res);

        expect(res.json).toHaveBeenCalledWith({
            id: "txn-43",
            notes: "Merchant: WWW.TADA.G* N01A04E712\nStatement: DBS Yuu | 2026-06-01..2026-06-30\n\nuser note",
        });
    });

    test("returns 404 when transaction not found", async () => {
        actual.getTransactions.mockResolvedValue([{ id: "another-transaction" }]);
        const handler = findHandler("get", "/transactions/:id");
        const res = mockRes();

        await handler(mockReq({ params: { id: "missing" } }), res);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({
            error: "Transaction not found",
        });
    });

    test("returns 500 on API error", async () => {
        actual.getTransactions.mockRejectedValue(new Error("DB down"));
        const handler = findHandler("get", "/transactions/:id");
        const res = mockRes();

        await handler(mockReq({ params: { id: "err" } }), res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: "DB down" });
    });
});

describe("POST /transactions enriched response", () => {
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
        actual.addTransactions.mockReset();
        actual.init.mockResolvedValue(undefined);
        actual.getBudgets.mockResolvedValue([
            { name: "TestBudget", groupId: "g1" },
        ]);
        actual.downloadBudget.mockResolvedValue(undefined);
        actual.addTransactions.mockResolvedValue(["new-id-99"]);
    });

    test("returns full transaction with id, account, date, amount, payee_name, notes, category, cleared", async () => {
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    payee_name: "BUS/MRT",
                    notes: "Transport",
                    category: "cat-transport",
                },
            }),
            res,
        );

        expect(res.json).toHaveBeenCalledWith({
            id: "new-id-99",
            account: "acc-1",
            date: "2026-06-17",
            amount: -425,
            payee_name: "BUS/MRT",
            notes: "Transport",
            category: "cat-transport",
            cleared: false,
        });
    });

    test("category is null when not provided", async () => {
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -100,
                },
            }),
            res,
        );

        expect(res.json.mock.calls[0][0].category).toBeNull();
    });
});

describe("GET /accounts/balance/:id", () => {
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
        actual.getAccountBalance.mockReset();
        actual.init.mockResolvedValue(undefined);
    });

    test("returns account balance by id", async () => {
        actual.getAccountBalance.mockResolvedValue(50000);
        const handler = findHandler("get", "/accounts/balance/:id");
        const res = mockRes();

        await handler(mockReq({ params: { id: "acc-1" } }), res);

        expect(actual.getAccountBalance).toHaveBeenCalledWith(
            "acc-1",
            undefined,
        );
        expect(res.json).toHaveBeenCalledWith({ id: "acc-1", balance: 50000 });
    });

    test("passes cutoff date to getAccountBalance when provided", async () => {
        actual.getAccountBalance.mockResolvedValue(42000);
        const handler = findHandler("get", "/accounts/balance/:id");
        const res = mockRes();

        await handler(
            mockReq({
                params: { id: "acc-2" },
                query: { cutoff: "2026-06-01" },
            }),
            res,
        );

        expect(actual.getAccountBalance).toHaveBeenCalledWith(
            "acc-2",
            expect.any(Date),
        );
        const cutoffArg = actual.getAccountBalance.mock.calls[0][1];
        expect(cutoffArg.toISOString()).toBe(
            "2026-06-01T00:00:00.000Z",
        );
        expect(res.json).toHaveBeenCalledWith({ id: "acc-2", balance: 42000 });
    });

    test("returns 400 when account id is empty", async () => {
        const handler = findHandler("get", "/accounts/balance/:id");
        const res = mockRes();

        await handler(mockReq({ params: { id: "" } }), res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            error: "Account id is required",
        });
    });

    test("returns 400 when cutoff date is invalid", async () => {
        const handler = findHandler("get", "/accounts/balance/:id");
        const res = mockRes();

        await handler(
            mockReq({
                params: { id: "acc-1" },
                query: { cutoff: "not-a-date" },
            }),
            res,
        );

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            error: "Invalid cutoff date (use YYYY-MM-DD)",
        });
    });

    test("returns 500 on API error", async () => {
        actual.getAccountBalance.mockRejectedValue(new Error("Not found"));
        const handler = findHandler("get", "/accounts/balance/:id");
        const res = mockRes();

        await handler(mockReq({ params: { id: "acc-99" } }), res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: "Not found" });
    });
});
