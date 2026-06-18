/**
 * Tests for timestamped logging wrapper.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createTimestampedLogger } from "../src/logging.js";

describe("createTimestampedLogger", () => {
    let output;

    beforeEach(() => {
        output = [];
    });

    function makeLogger() {
        return createTimestampedLogger((...args) => {
            output.push(args);
        });
    }

    test("injects timestamp into JSON log line without one", () => {
        const log = makeLogger();
        log(JSON.stringify({ event: "test", value: 42 }));
        expect(output).toHaveLength(1);
        const parsed = JSON.parse(output[0][0]);
        expect(parsed.event).toBe("test");
        expect(parsed.value).toBe(42);
        expect(typeof parsed.timestamp).toBe("string");
        expect(parsed.timestamp).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
        );
    });

    test("preserves existing timestamp", () => {
        const log = makeLogger();
        const existing = "2026-01-01T00:00:00.000Z";
        log(JSON.stringify({ event: "test", timestamp: existing }));
        const parsed = JSON.parse(output[0][0]);
        expect(parsed.timestamp).toBe(existing);
    });

    test("passes through non-JSON string unchanged", () => {
        const log = makeLogger();
        log("plain text message");
        expect(output).toEqual([["plain text message"]]);
    });

    test("passes through string that looks like JSON but is invalid", () => {
        const log = makeLogger();
        log("{broken json");
        expect(output).toEqual([["{broken json"]]);
    });

    test("passes through non-string argument", () => {
        const log = makeLogger();
        log(42);
        expect(output).toEqual([[42]]);
    });

    test("passes through multiple arguments", () => {
        const log = makeLogger();
        log("a", "b", "c");
        expect(output).toEqual([["a", "b", "c"]]);
    });

    test("does not inject timestamp when string doesn't start with {", () => {
        const log = makeLogger();
        log('  {"event":"test"}'); // leading whitespace
        expect(output[0][0]).toBe('  {"event":"test"}');
    });
});
