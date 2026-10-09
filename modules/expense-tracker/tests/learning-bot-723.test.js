/**
 * Issue #723: the learning offer is answered with buttons on a dedicated bot,
 * so the model never holds the confirm path. Offline: the Telegram fetch is a
 * double and the offer file lives in a temp directory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("mailparser", () => ({ simpleParser: vi.fn() }));
vi.mock("better-sqlite3", () => ({ default: vi.fn() }));
vi.mock("@xenova/transformers", () => ({ pipeline: vi.fn(), env: {} }));
vi.mock("../src/dedup.js", () => ({
    DedupJournal: vi.fn(function () {
        this.record = vi.fn();
        this.checkDuplicate = vi.fn(() => false);
        this.close = vi.fn();
    }),
}));

import { ToolRegistry } from "../src/tools.js";
import { Config } from "../src/config.js";
import { migratePendingLearning } from "../src/learning.js";
import { LearningBot, signCallback, verifyCallback } from "../src/learning-bot.js";
import { toolShapes, createTools } from "../src/mcp-server.js";

const CHAT = "4242";
const TOKEN = "123:test-token";
const SECRET = "s3cret";
const PAYEES = [
    { id: "p-misc", name: "Misc" },
    { id: "p-interest", name: "Bank Interest" },
];

let dir;
let memory;
let telegram;

function telegramFetch() {
    telegram = [];
    return vi.fn(async (url, init) => {
        const method = String(url).split("/").pop();
        const body = init?.body ? JSON.parse(init.body) : {};
        telegram.push({ method, body });
        if (method === "getUpdates") return { ok: true, json: async () => ({ ok: true, result: [] }) };
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) };
    });
}
const calls = (method) => telegram.filter((c) => c.method === method);

function registry(config = {}) {
    const reg = new ToolRegistry(
        {
            dedupDbPath: ":memory:",
            primaryBudgetFile: "budget-sgd",
            pendingLearningPath: join(dir, "state", "pending.json"),
            ...config,
        },
        memory,
    );
    reg._get = vi.fn(async () => PAYEES);
    return reg;
}
const botConfig = { learningBotToken: TOKEN, learningBotChatId: CHAT };

function setup(config = botConfig) {
    const reg = registry(config);
    const fetchFn = telegramFetch();
    const bot = new LearningBot({ token: TOKEN, chatId: CHAT, registry: reg, fetchFn, sleep: async () => {} });
    reg.setLearningBot(bot);
    return { reg, bot, fetchFn };
}

function press(data, { chat = CHAT, from = CHAT } = {}) {
    return {
        update_id: 1,
        callback_query: {
            id: "cb1",
            from: { id: Number(from) },
            message: { message_id: 7, chat: { id: Number(chat) } },
            data,
        },
    };
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "learning-723-"));
    memory = {
        search: vi.fn(async () => []),
        add: vi.fn(async () => ({ added: true, skipped: false, reason: "" })),
        listFacts: vi.fn(() => []),
    };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("callback signing (#723)", () => {
    it("round-trips and fits Telegram's 64-byte limit", () => {
        const data = signCallback("r", "ABCDEFGH", SECRET);
        expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
        expect(verifyCallback(data, SECRET)).toEqual({ action: "r", offerId: "ABCDEFGH" });
        expect(verifyCallback(signCallback("d", "ABCDEFGH", SECRET), SECRET).action).toBe("d");
    });

    it("rejects tampered data, a wrong action, a wrong id and a wrong secret", () => {
        const data = signCallback("d", "ABCDEFGH", SECRET);
        const [, id, mac] = data.split(":");
        expect(verifyCallback(`r:${id}:${mac}`, SECRET)).toBeNull();
        expect(verifyCallback(`d:ZZZZZZZZ:${mac}`, SECRET)).toBeNull();
        expect(verifyCallback(`${data}0`, SECRET)).toBeNull();
        expect(verifyCallback(`d:${id}:${"0".repeat(mac.length)}`, SECRET)).toBeNull();
        expect(verifyCallback(data, "other")).toBeNull();
        expect(verifyCallback("garbage", SECRET)).toBeNull();
        expect(verifyCallback(undefined, SECRET)).toBeNull();
    });
});

describe("sending and answering an offer (#723)", () => {
    it("propose_learning sends one message with Remember and Don't buttons to the chat", async () => {
        const { reg } = setup();
        const result = await reg.executeTool("propose_learning", {
            descriptor: "360 SAVE BONUS", payee: "Bank Interest", runner_up: "Salary", budget_id: "b",
        });
        expect(result.offered).toBe(true);
        const [sent] = calls("sendMessage");
        expect(sent.body.chat_id).toBe(CHAT);
        expect(sent.body.text).toContain("360 SAVE BONUS");
        expect(sent.body.text).toContain("Bank Interest");
        expect(sent.body.text).toContain("Salary");
        const buttons = sent.body.reply_markup.inline_keyboard.flat();
        expect(buttons.map((b) => b.text)).toEqual(["Remember", "Don't"]);
        for (const b of buttons) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    });

    it("a failed send does not fail the offer", async () => {
        const { reg, bot } = setup();
        bot._fetch = vi.fn(async () => { throw new Error("down"); });
        const result = await reg.executeTool("propose_learning", {
            descriptor: "360 SAVE BONUS", payee: "Bank Interest", budget_id: "b",
        });
        expect(result.offered).toBe(true);
    });

    async function offered() {
        const ctx = setup();
        const { id } = await ctx.reg.executeTool("propose_learning", {
            descriptor: "360 SAVE BONUS", payee: "Bank Interest", budget_id: "b",
        });
        const buttons = calls("sendMessage")[0].body.reply_markup.inline_keyboard.flat();
        return { ...ctx, id, remember: buttons[0].callback_data, dont: buttons[1].callback_data };
    }

    it("Remember learns exactly one fact and edits the message", async () => {
        const { reg, bot, id, remember } = await offered();
        await bot.handleUpdate(press(remember));
        expect(memory.add).toHaveBeenCalledTimes(1);
        expect(memory.add.mock.calls[0][0]).toBe("360 SAVE BONUS maps to Bank Interest payee");
        expect(reg._pendingLearning.get(id)).toBeNull();
        expect(calls("answerCallbackQuery")).toHaveLength(1);
        expect(calls("editMessageText")).toHaveLength(1);
        expect(calls("editMessageText")[0].body.text).toMatch(/remember/i);
    });

    it("Don't learns nothing and discards the offer", async () => {
        const { reg, bot, id, dont } = await offered();
        await bot.handleUpdate(press(dont));
        expect(memory.add).not.toHaveBeenCalled();
        expect(reg._pendingLearning.get(id)).toBeNull();
        expect(calls("answerCallbackQuery")).toHaveLength(1);
        expect(calls("editMessageText")).toHaveLength(1);
    });

    it("a second press of Remember learns nothing more", async () => {
        const { bot, remember } = await offered();
        await bot.handleUpdate(press(remember));
        await bot.handleUpdate(press(remember));
        expect(memory.add).toHaveBeenCalledTimes(1);
        expect(calls("answerCallbackQuery")).toHaveLength(2);
    });

    it("rejects a press from another chat or user but still answers it", async () => {
        const { reg, bot, id, remember } = await offered();
        await bot.handleUpdate(press(remember, { chat: "999", from: "999" }));
        await bot.handleUpdate(press(remember, { chat: CHAT, from: "999" }));
        expect(memory.add).not.toHaveBeenCalled();
        expect(reg._pendingLearning.get(id)).not.toBeNull();
        expect(calls("answerCallbackQuery")).toHaveLength(2);
        expect(calls("editMessageText")).toHaveLength(0);
    });

    it("rejects a forged signature", async () => {
        const { reg, bot, id } = await offered();
        await bot.handleUpdate(press(`r:${id}:${"a".repeat(24)}`));
        expect(memory.add).not.toHaveBeenCalled();
        expect(reg._pendingLearning.get(id)).not.toBeNull();
        expect(calls("answerCallbackQuery")).toHaveLength(1);
    });

    it("rejects an expired offer without learning", async () => {
        const { reg, bot, remember } = await offered();
        const real = Date.now();
        reg._pendingLearning._now = () => real + 8 * 24 * 60 * 60 * 1000;
        await bot.handleUpdate(press(remember));
        expect(memory.add).not.toHaveBeenCalled();
        expect(calls("answerCallbackQuery")).toHaveLength(1);
    });

    it("never throws on a malformed update", async () => {
        const { bot } = setup();
        await expect(bot.handleUpdate({})).resolves.toBeUndefined();
        await expect(bot.handleUpdate({ callback_query: {} })).resolves.toBeUndefined();
    });
});

describe("polling loop (#723)", () => {
    it("polls getUpdates with the offset and callback_query only, and survives an error", async () => {
        const { bot } = setup();
        let n = 0;
        bot._fetch = vi.fn(async (url, init) => {
            const body = JSON.parse(init.body);
            telegram.push({ method: String(url).split("/").pop(), body });
            n += 1;
            if (n === 1) throw new Error("network");
            if (n === 2) return { ok: true, json: async () => ({ ok: true, result: [{ update_id: 10 }] }) };
            bot.stop();
            return { ok: true, json: async () => ({ ok: true, result: [] }) };
        });
        await bot.start();
        await bot._loopDone;
        const polls = calls("getUpdates");
        expect(polls.length).toBeGreaterThanOrEqual(3);
        expect(polls[0].body).toMatchObject({ timeout: 50, allowed_updates: ["callback_query"] });
        expect(polls[2].body.offset).toBe(11);
    });
});

describe("model-facing surface (#723)", () => {
    const names = (reg) => reg.getToolSchemas().map((t) => t.function.name);

    it("with the bot, confirm_learning is gone from the tools list and cannot be executed", async () => {
        const { reg } = setup();
        expect(names(reg)).not.toContain("confirm_learning");
        expect(names(reg)).toContain("decline_learning");
        expect(await reg.executeTool("confirm_learning", { id: "ABCDEFGH" })).toMatchObject({ confirmed: false });
        expect(memory.add).not.toHaveBeenCalled();
    });

    it("with the bot, MCP does not register confirm_learning", () => {
        const { reg } = setup();
        const tool = vi.fn();
        createTools({ tool }, reg);
        const registered = tool.mock.calls.map((c) => c[0]);
        expect(registered).not.toContain("confirm_learning");
        expect(registered).toContain("decline_learning");
        expect(registered).toContain("list_pending_learning");
    });

    it("with the bot, list_pending_learning omits offer ids", async () => {
        const { reg } = setup();
        await reg.executeTool("propose_learning", { descriptor: "360 SAVE BONUS", payee: "Bank Interest", budget_id: "b" });
        const { offers } = await reg.executeTool("list_pending_learning", {});
        expect(offers).toHaveLength(1);
        expect(offers[0]).not.toHaveProperty("id");
        expect(offers[0].descriptor).toBe("360 SAVE BONUS");
    });

    it("without the bot, nothing changes", async () => {
        const reg = registry();
        const tool = vi.fn();
        createTools({ tool }, reg);
        expect(names(reg)).toContain("confirm_learning");
        expect(tool.mock.calls.map((c) => c[0])).toContain("confirm_learning");
        const { id } = await reg.executeTool("propose_learning", { descriptor: "360 SAVE BONUS", payee: "Bank Interest", budget_id: "b" });
        expect((await reg.executeTool("list_pending_learning", {})).offers[0].id).toBe(id);
        expect(await reg.executeTool("confirm_learning", { id })).toMatchObject({ confirmed: true });
        expect(toolShapes.confirm_learning).toBeDefined();
    });
});

describe("config and store location (#723)", () => {
    it("reads the bot settings and defaults the store under state/", () => {
        const cfg = new Config({ LEARNING_BOT_TOKEN: "t", LEARNING_BOT_CHAT_ID: "9" });
        expect(cfg.learningBotToken).toBe("t");
        expect(cfg.learningBotChatId).toBe("9");
        expect(cfg.pendingLearningPath).toBe("state/pending-learning.json");
        expect(new Config({}).learningBotToken).toBe("");
    });

    it("migrates the old offer file once and never overwrites the new one", () => {
        const oldPath = join(dir, "data", "pending-learning.json");
        const newPath = join(dir, "state", "pending-learning.json");
        mkdirSync(join(dir, "data"));
        writeFileSync(oldPath, '{"offers":[1]}');
        expect(migratePendingLearning(oldPath, newPath)).toBe(true);
        expect(existsSync(oldPath)).toBe(false);
        expect(readFileSync(newPath, "utf8")).toBe('{"offers":[1]}');

        writeFileSync(oldPath, '{"offers":[2]}');
        expect(migratePendingLearning(oldPath, newPath)).toBe(false);
        expect(readFileSync(newPath, "utf8")).toBe('{"offers":[1]}');
        expect(migratePendingLearning(join(dir, "none.json"), join(dir, "x", "y.json"))).toBe(false);
    });
});
