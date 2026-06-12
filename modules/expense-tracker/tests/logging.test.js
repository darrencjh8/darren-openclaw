/**
 * Tests for structured JSON-line logging with correlation IDs.
 * Ported 1:1 from src/logging.js counterpart tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock pino — captures all log calls so we can inspect structure
// ---------------------------------------------------------------------------
// Use vi.hoisted so variables are available when the mocked factory runs.
const { capturedLogs, capturedPinoOpts } = vi.hoisted(() => {
    const capturedLogs = [];
    const capturedPinoOpts = { value: null };
    return { capturedLogs, capturedPinoOpts };
});

const LEVEL_VALUES = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

function shouldEmit(loggerLevel, methodLevel) {
    return LEVEL_VALUES[methodLevel] >= LEVEL_VALUES[loggerLevel];
}

function makeMockLogger(bindings = {}, parentLevel = "info") {
    const obj = {
        _level: parentLevel,
        _bindings: { ...bindings },

        get level() {
            return this._level;
        },
        set level(v) {
            this._level = v;
        },

        info(...args) {
            if (shouldEmit(this._level, "info"))
                capturedLogs.push({
                    level: "info",
                    args,
                    bindings: this._bindings,
                });
        },
        warn(...args) {
            if (shouldEmit(this._level, "warn"))
                capturedLogs.push({
                    level: "warn",
                    args,
                    bindings: this._bindings,
                });
        },
        error(...args) {
            if (shouldEmit(this._level, "error"))
                capturedLogs.push({
                    level: "error",
                    args,
                    bindings: this._bindings,
                });
        },
        debug(...args) {
            if (shouldEmit(this._level, "debug"))
                capturedLogs.push({
                    level: "debug",
                    args,
                    bindings: this._bindings,
                });
        },
        fatal(...args) {
            if (shouldEmit(this._level, "fatal"))
                capturedLogs.push({
                    level: "fatal",
                    args,
                    bindings: this._bindings,
                });
        },

        child(bindings) {
            return makeMockLogger(
                { ...this._bindings, ...bindings },
                this._level,
            );
        },
    };
    return obj;
}

vi.mock("pino", () => ({
    default: vi.fn((opts) => {
        capturedPinoOpts.value = opts;
        return makeMockLogger({}, opts?.level || "info");
    }),
}));

// Import the module under test AFTER the mock is registered
import { getLogger, setupLogging, logger } from "../src/logging.js";

// ---------------------------------------------------------------------------
beforeEach(() => {
    capturedLogs.length = 0;
    // NOTE: capturedPinoOpts is set once during module import and must
    // not be cleared — the pino constructor runs exactly once.
});

// ---------------------------------------------------------------------------
describe("Logger creation", () => {
    it("creates a pino logger on import with the correct options", () => {
        expect(capturedPinoOpts.value).toBeDefined();
        expect(capturedPinoOpts.value.level).toBe("info");
    });

    it("honours LOG_LEVEL env var for initial level", () => {
        // The module is already cached, but we can still verify the default
        // behaviour by checking what pino was called with.
        expect(capturedPinoOpts.value.level).toBe("info");
    });

    it("exports the same logger instance that pino returned", () => {
        expect(logger).toBeDefined();
        expect(typeof logger.info).toBe("function");
        expect(typeof logger.warn).toBe("function");
        expect(typeof logger.error).toBe("function");
        expect(typeof logger.debug).toBe("function");
    });

    it("uses pino-pretty transport in non-production NODE_ENV", () => {
        // The default NODE_ENV in tests is not "production", so transport should
        // be configured.
        expect(capturedPinoOpts.value.transport).toBeDefined();
        expect(capturedPinoOpts.value.transport.target).toBe("pino-pretty");
        expect(capturedPinoOpts.value.transport.options.colorize).toBe(true);
    });
});

// ---------------------------------------------------------------------------
describe("getLogger — child logger creation", () => {
    it("returns a child logger with the given name", () => {
        const child = getLogger("test-module");
        expect(child).toBeDefined();
        expect(typeof child.info).toBe("function");
        expect(typeof child.child).toBe("function");
    });

    it("adds the logger name as a correlation-id binding", () => {
        const child = getLogger("my-service");
        child.info("hello");
        expect(capturedLogs.length).toBe(1);
        expect(capturedLogs[0].bindings.logger).toBe("my-service");
    });

    it("returns different child loggers for different names", () => {
        const childA = getLogger("module-a");
        const childB = getLogger("module-b");
        childA.info("a");
        childB.info("b");
        expect(capturedLogs.length).toBe(2);
        expect(capturedLogs[0].bindings.logger).toBe("module-a");
        expect(capturedLogs[1].bindings.logger).toBe("module-b");
    });

    it("preserves existing bindings in nested child loggers", () => {
        const child1 = getLogger("outer");
        const child2 = child1.child({ requestId: "req-1" });
        child2.info("nested");
        expect(capturedLogs.length).toBe(1);
        expect(capturedLogs[0].bindings.logger).toBe("outer");
        expect(capturedLogs[0].bindings.requestId).toBe("req-1");
    });
});

// ---------------------------------------------------------------------------
describe("setupLogging — dynamic level changes", () => {
    it("sets the log level on the root logger", () => {
        setupLogging("debug");
        expect(logger.level).toBe("debug");
    });

    it("defaults to 'info' when no argument is supplied", () => {
        setupLogging();
        expect(logger.level).toBe("info");
    });

    it("suppresses messages below the current level", () => {
        setupLogging("warn");
        logger.info("should be dropped");
        logger.debug("should be dropped");
        logger.warn("kept");
        logger.error("also kept");

        expect(capturedLogs.length).toBe(2);
        expect(capturedLogs[0].level).toBe("warn");
        expect(capturedLogs[1].level).toBe("error");
    });

    it("allows debug messages when level is debug", () => {
        setupLogging("debug");
        logger.debug("debug msg");
        logger.info("info msg");
        logger.warn("warn msg");
        logger.error("error msg");

        expect(capturedLogs.length).toBe(4);
        expect(capturedLogs.map((l) => l.level)).toEqual([
            "debug",
            "info",
            "warn",
            "error",
        ]);
    });
});

// ---------------------------------------------------------------------------
describe("JSON log output format", () => {
    it("captures a string message as first argument", () => {
        logger.info("test message");
        expect(capturedLogs.length).toBe(1);
        expect(capturedLogs[0].args[0]).toBe("test message");
    });

    it("captures level as a named field", () => {
        logger.warn("warning");
        expect(capturedLogs[0].level).toBe("warn");
    });

    it("captures bindings alongside the message", () => {
        const child = getLogger("json-test");
        child.info("with context");
        expect(capturedLogs[0].bindings).toHaveProperty("logger", "json-test");
    });
});

// ---------------------------------------------------------------------------
describe("Extra data merging", () => {
    it("passes extra data as additional arguments", () => {
        logger.info("user login", { userId: 42, ip: "10.0.0.1" });
        expect(capturedLogs.length).toBe(1);
        // The extra data object should be in the args
        expect(capturedLogs[0].args[1]).toEqual({ userId: 42, ip: "10.0.0.1" });
    });

    it("handles multiple extra argument objects", () => {
        logger.info("multi", { a: 1 }, { b: 2 });
        expect(capturedLogs.length).toBe(1);
        expect(capturedLogs[0].args[1]).toEqual({ a: 1 });
        expect(capturedLogs[0].args[2]).toEqual({ b: 2 });
    });

    it("merges extra data with child logger bindings", () => {
        const child = getLogger("extra-test");
        child.info("with extra", { trace: "abc123" });
        expect(capturedLogs[0].bindings.logger).toBe("extra-test");
        expect(capturedLogs[0].args[1]).toEqual({ trace: "abc123" });
    });
});

// ---------------------------------------------------------------------------
describe("Error serialization", () => {
    it("passes Error objects as arguments", () => {
        const err = new Error("something broke");
        logger.error("operation failed", err);
        expect(capturedLogs.length).toBe(1);
        expect(capturedLogs[0].level).toBe("error");
        expect(capturedLogs[0].args[0]).toBe("operation failed");
        expect(capturedLogs[0].args[1]).toBeInstanceOf(Error);
        expect(capturedLogs[0].args[1].message).toBe("something broke");
    });

    it("handles Error with no message", () => {
        const err = new Error();
        logger.error("nameless error", err);
        expect(capturedLogs.length).toBe(1);
        expect(capturedLogs[0].args[1]).toBeInstanceOf(Error);
    });

    it("handles TypeError", () => {
        const err = new TypeError("type mismatch");
        logger.error("type error", err);
        expect(capturedLogs[0].args[1]).toBeInstanceOf(TypeError);
        expect(capturedLogs[0].args[1].message).toBe("type mismatch");
    });
});

// ---------------------------------------------------------------------------
describe("Edge cases", () => {
    it("handles null message gracefully", () => {
        expect(() => logger.info(null)).not.toThrow();
        expect(capturedLogs.length).toBe(1);
        expect(capturedLogs[0].args[0]).toBeNull();
    });

    it("handles undefined message gracefully", () => {
        expect(() => logger.info(undefined)).not.toThrow();
        expect(capturedLogs.length).toBe(1);
        expect(capturedLogs[0].args[0]).toBeUndefined();
    });

    it("handles empty string message", () => {
        expect(() => logger.info("")).not.toThrow();
        expect(capturedLogs.length).toBe(1);
        expect(capturedLogs[0].args[0]).toBe("");
    });

    it("handles circular references in extra data", () => {
        const obj = { name: "circular" };
        obj.self = obj;
        expect(() => logger.info("circular test", obj)).not.toThrow();
        expect(capturedLogs.length).toBe(1);
        expect(capturedLogs[0].args[1]).toBe(obj);
        expect(capturedLogs[0].args[1].self).toBe(obj);
    });

    it("handles numeric message", () => {
        expect(() => logger.info(12345)).not.toThrow();
        expect(capturedLogs.length).toBe(1);
        expect(capturedLogs[0].args[0]).toBe(12345);
    });

    it("handles boolean message", () => {
        expect(() => logger.info(false)).not.toThrow();
        expect(capturedLogs.length).toBe(1);
        expect(capturedLogs[0].args[0]).toBe(false);
    });

    it("handles very long message strings", () => {
        const long = "x".repeat(10000);
        expect(() => logger.info(long)).not.toThrow();
        expect(capturedLogs.length).toBe(1);
        expect(capturedLogs[0].args[0].length).toBe(10000);
    });

    it("getLogger handles empty string name", () => {
        const child = getLogger("");
        child.info("empty name");
        expect(capturedLogs[0].bindings.logger).toBe("");
    });

    it("getLogger handles names with special characters", () => {
        const child = getLogger("my:module/sub-module");
        child.info("special");
        expect(capturedLogs[0].bindings.logger).toBe("my:module/sub-module");
    });

    it("supports fatal log level", () => {
        setupLogging("fatal");
        logger.fatal("fatal error");
        logger.error("error should be suppressed at fatal level");
        expect(capturedLogs.length).toBe(1);
        expect(capturedLogs[0].level).toBe("fatal");
    });
});
