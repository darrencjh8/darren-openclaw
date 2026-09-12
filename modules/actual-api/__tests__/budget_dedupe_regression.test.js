/**
 * Regression test for the dedupe wrapper dropping the configured budget name
 * (issue #390 follow-up).
 *
 * The library can list one budget once per DATA_DIR copy: same sync id, often a
 * different name. The shared lookup used to deduplicate by sync id and keep the
 * first twin, so when the twin that carried the configured
 * `ACTUAL_PRIMARY_BUDGET_FILE` name came second, `init()` failed and every read
 * answered 500 `Budget "test-budget" not found`. Duplicates are now harmless in
 * the lookup path, and only `GET /budgets` deduplicates for display.
 *
 * This file owns its module registry because `initialized` and `activeSyncId`
 * are module state and the mocked list must be the twin-bearing one.
 */
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
    updateTransaction: jest.fn(),
    deleteTransaction: jest.fn(),
    getAccountBalance: jest.fn(),
}));

const actual = require("@actual-app/api");
require("../server");

// jest.setup.js sets ACTUAL_PRIMARY_BUDGET_FILE="test-budget". The configured
// budget is the SECOND entry on purpose: deduplicating by sync id and keeping
// the first entry dropped it.
const BUDGETS = [
    { name: "Renamed SGD", groupId: "g1", cloudFileId: "cloud-g1" },
    { name: "test-budget", groupId: "g1", cloudFileId: "cloud-g1" },
];
const ACCOUNTS = [{ id: "acc-1", name: "SGD account" }];

function findHandler(method, path) {
    const call = mockApp[method].mock.calls.find(([p]) => p === path);
    return call ? call[1] : null;
}

function mockRes() {
    return {
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
    };
}

function mockReq(overrides = {}) {
    return { query: {}, body: null, params: {}, ...overrides };
}

beforeEach(() => {
    // Reset only the library stubs: resetting mockApp would drop the recorded
    // route registrations that findHandler reads.
    actual.init.mockReset();
    actual.getBudgets.mockReset();
    actual.downloadBudget.mockReset();
    actual.getAccounts.mockReset();
    actual.init.mockResolvedValue(undefined);
    actual.getBudgets.mockResolvedValue(BUDGETS);
    actual.downloadBudget.mockResolvedValue(undefined);
    actual.getAccounts.mockResolvedValue(ACCOUNTS);
});

test("GET /accounts serves the configured budget whose same-id twin is listed first", async () => {
    const handler = findHandler("get", "/accounts");
    const res = mockRes();

    await handler(mockReq({ query: { budget_id: "test-budget" } }), res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(ACCOUNTS);
    expect(actual.downloadBudget).toHaveBeenCalledWith("g1", {
        password: undefined,
    });
});

test("GET /budgets returns one entry per sync id and prefers the configured name", async () => {
    const handler = findHandler("get", "/budgets");
    const res = mockRes();

    await handler(mockReq(), res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith([
        { name: "test-budget", groupId: "g1", cloudFileId: "cloud-g1" },
    ]);
});

test("logs dropped duplicates on every GET /budgets call, not once per process", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
        const handler = findHandler("get", "/budgets");
        await handler(mockReq(), mockRes());
        await handler(mockReq(), mockRes());

        const dropLogs = logSpy.mock.calls.filter(
            ([message]) =>
                typeof message === "string" && message.includes("dropped"),
        );
        // Wording is deliberately not pinned beyond the word "dropped": only
        // the per-call behaviour matters here.
        expect(dropLogs).toHaveLength(2);
    } finally {
        logSpy.mockRestore();
    }
});
