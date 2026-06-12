/**
 * Unit tests for IMAP IDLE handler.
 * Ported from tests/test_imap_notifier.py
 */
import { describe, it, expect, vi } from "vitest";
import { ImapIdleHandler } from "../src/imap.js";

describe("ImapIdleHandler constructor", () => {
    it("stores all connection parameters", () => {
        const handler = new ImapIdleHandler(
            "imap.example.com",
            993,
            "user@example.com",
            "app-pass",
        );
        expect(handler._host).toBe("imap.example.com");
        expect(handler._port).toBe(993);
        expect(handler._username).toBe("user@example.com");
        expect(handler._password).toBe("app-pass");
        expect(handler._client).toBeNull();
        expect(handler._running).toBe(false);
    });
});

describe("ImapIdleHandler disconnect", () => {
    it("closes and logs out when client exists", async () => {
        const handler = new ImapIdleHandler(
            "imap.example.com",
            993,
            "user@example.com",
            "pass",
        );
        const mockClient = {
            logout: vi.fn(async () => {}),
        };
        handler._client = mockClient;

        await handler.disconnect();
        expect(mockClient.logout).toHaveBeenCalledOnce();
        expect(handler._client).toBeNull();
    });

    it("handles logout errors gracefully", async () => {
        const handler = new ImapIdleHandler(
            "imap.example.com",
            993,
            "user@example.com",
            "pass",
        );
        const mockClient = {
            logout: vi.fn(async () => {
                throw new Error("connection broken");
            }),
        };
        handler._client = mockClient;

        await handler.disconnect();
        expect(handler._client).toBeNull();
    });

    it("is a no-op when client is already null", async () => {
        const handler = new ImapIdleHandler(
            "imap.example.com",
            993,
            "user@example.com",
            "pass",
        );
        handler._client = null;
        await expect(handler.disconnect()).resolves.toBeUndefined();
        expect(handler._client).toBeNull();
    });
});

describe("ImapIdleHandler fetchUnread", () => {
    it("returns empty array when no client", async () => {
        const handler = new ImapIdleHandler(
            "imap.example.com",
            993,
            "user@example.com",
            "pass",
        );
        handler._client = null;
        const result = await handler.fetchUnread();
        expect(result).toEqual([]);
    });

    it("returns structured messages when emails exist", async () => {
        const handler = new ImapIdleHandler(
            "imap.example.com",
            993,
            "user@example.com",
            "pass",
        );

        // Create a mock async iterable
        const mockMessages = [
            {
                seq: 1,
                source: Buffer.from(
                    "From: test@test.com\r\nSubject: Test Alert\r\nDate: Thu, 04 Jun 2026\r\n\r\nBody content",
                ),
                envelope: {},
            },
            {
                seq: 2,
                source: Buffer.from(
                    "From: alerts@dbs.com\r\nSubject: S$12.80 spent\r\nDate: Thu, 04 Jun 2026\r\n\r\nTransaction",
                ),
                envelope: {},
            },
        ];

        const mockClient = {
            fetch: vi.fn(function* () {
                for (const msg of mockMessages) {
                    yield msg;
                }
            }),
        };

        // Override fetch to return an async iterable
        mockClient.fetch = vi.fn(() => {
            return {
                [Symbol.asyncIterator]() {
                    let idx = 0;
                    return {
                        async next() {
                            if (idx < mockMessages.length) {
                                return { value: mockMessages[idx++], done: false };
                            }
                            return { value: undefined, done: true };
                        },
                    };
                },
            };
        });

        handler._client = mockClient;

        const result = await handler.fetchUnread();
        expect(result.length).toBe(2);
        expect(result[0].msg_id).toBe("1");
        expect(result[0].from).toBeDefined();
        expect(result[0].subject).toBeDefined();
        expect(result[0].raw_email).toBeDefined();
        expect(result[1].msg_id).toBe("2");
    });

    it("returns empty array when no unseen messages", async () => {
        const handler = new ImapIdleHandler(
            "imap.example.com",
            993,
            "user@example.com",
            "pass",
        );

        const mockClient = {
            fetch: vi.fn(() => {
                return {
                    [Symbol.asyncIterator]() {
                        return {
                            async next() {
                                return { value: undefined, done: true };
                            },
                        };
                    },
                };
            }),
        };

        handler._client = mockClient;
        const result = await handler.fetchUnread();
        expect(result).toEqual([]);
    });
});

describe("ImapIdleHandler markRead", () => {
    it("sets Seen flag on the message", async () => {
        const handler = new ImapIdleHandler(
            "imap.example.com",
            993,
            "user@example.com",
            "pass",
        );

        const mockClient = {
            messageFlagsAdd: vi.fn(async () => {}),
        };
        handler._client = mockClient;

        await handler.markRead("42");
        expect(mockClient.messageFlagsAdd).toHaveBeenCalledWith(
            { seq: "42" },
            ["\\Seen"],
        );
    });

    it("handles integer msgId by converting to string", async () => {
        const handler = new ImapIdleHandler(
            "imap.example.com",
            993,
            "user@example.com",
            "pass",
        );

        const mockClient = {
            messageFlagsAdd: vi.fn(async () => {}),
        };
        handler._client = mockClient;

        await handler.markRead(42);
        expect(mockClient.messageFlagsAdd).toHaveBeenCalledWith(
            { seq: 42 },
            ["\\Seen"],
        );
    });

    it("handles errors gracefully (no client)", async () => {
        const handler = new ImapIdleHandler(
            "imap.example.com",
            993,
            "user@example.com",
            "pass",
        );
        handler._client = null;
        await expect(handler.markRead("1")).resolves.toBeUndefined();
    });

    it("handles client errors gracefully", async () => {
        const handler = new ImapIdleHandler(
            "imap.example.com",
            993,
            "user@example.com",
            "pass",
        );
        const mockClient = {
            messageFlagsAdd: vi.fn(async () => {
                throw new Error("IMAP error");
            }),
        };
        handler._client = mockClient;

        await expect(handler.markRead("1")).resolves.toBeUndefined();
    });
});
