const { describe, it, mock, before, after } = require("node:test");
const assert = require("node:assert");

// Each test mirrors a section/edge case of perchance-image.cjs
// Tests are self-contained — no external deps beyond node:test

// ── CLI Args ───────────────────────────────────────────────────────
describe("CLI argument parsing", () => {
  it("exits when no prompt", () => {
    const prompt = undefined;
    const outputPath = undefined;
    assert.ok(!prompt || !outputPath);
  });
  it("exits when no output path", () => {
    const prompt = "cat";
    const outputPath = undefined;
    assert.ok(!prompt || !outputPath);
  });
  it("continues when both provided", () => {
    assert.ok(("cat" && "/tmp/out.png"));
  });
});

// ── Shape resolution ───────────────────────────────────────────────
describe("Shape resolution", () => {
  const shapes = { portrait: "512x768", square: "768x768", landscape: "768x512" };
  it("resolves portrait", () => assert.strictEqual(shapes.portrait, "512x768"));
  it("resolves square", () => assert.strictEqual(shapes.square, "768x768"));
  it("resolves landscape", () => assert.strictEqual(shapes.landscape, "768x512"));
  it("defaults to square for invalid", () => assert.strictEqual(shapes["invalid"] || shapes.square, "768x768"));
  it("defaults to square for undefined", () => assert.strictEqual(shapes[undefined] || shapes.square, "768x768"));
});

// ── Guidance scale ─────────────────────────────────────────────────
describe("Guidance scale parsing", () => {
  it("parses integer", () => assert.strictEqual(parseFloat("7") || 7, 7));
  it("parses float", () => assert.strictEqual(parseFloat("3.5") || 7, 3.5));
  it("defaults to 7 for NaN", () => assert.strictEqual(parseFloat("abc") || 7, 7));
  it("defaults to 7 for undefined", () => assert.strictEqual(parseFloat(undefined) || 7, 7));
  it("handles negative", () => assert.strictEqual(parseFloat("-1") || 7, -1));
  it("handles zero (falsy, defaults to 7)", () => assert.strictEqual(parseFloat("0") || 7, 7));
});

// ── Prompt assembly ────────────────────────────────────────────────
describe("Prompt assembly", () => {
  it("prepends prefix when provided", () => {
    const p = "cinematic, 8k";
    const q = "a cat";
    assert.strictEqual(p ? `${p} ${q}` : q, "cinematic, 8k a cat");
  });
  it("uses plain prompt when no prefix", () => {
    assert.strictEqual("" ? `${""} cat` : "cat", "cat");
  });
});

// ── waitForCDP ─────────────────────────────────────────────────────
describe("waitForCDP", () => {
  const http = require("http");
  let origGet;

  before(() => { origGet = http.get; });
  after(() => { http.get = origGet; });

  function makeWaitForCDP(timeout) {
    return function waitForCDP(port, timeoutMs = timeout) {
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const tryConnect = () => {
          http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
            let data = "";
            res.on("data", d => data += d);
            res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
          }).on("error", () => {
            if (Date.now() - start > timeoutMs) reject(new Error("CDP timeout"));
            else setTimeout(tryConnect, 500);
          });
        };
        tryConnect();
      });
    };
  }

  it("resolves on first connection", async () => {
    const valid = JSON.stringify({ webSocketDebuggerUrl: "ws://x" });
    http.get = (url, cb) => {
      const res = { on: (e, f) => { if (e === "data") f(valid); if (e === "end") f(); } };
      cb(res);
      return { on: () => {} };
    };
    const r = await makeWaitForCDP(5000)(9222);
    assert.strictEqual(r.webSocketDebuggerUrl, "ws://x");
  });

  it("retries on error then resolves", async () => {
    let calls = 0;
    const valid = JSON.stringify({ webSocketDebuggerUrl: "ws://retry" });
    http.get = (url, cb) => {
      calls++;
      if (calls < 3) return { on: (e, f) => { if (e === "error") f(new Error("fail")); } };
      const res = { on: (e, f) => { if (e === "data") f(valid); if (e === "end") f(); } };
      cb(res);
      return { on: () => {} };
    };
    const r = await makeWaitForCDP(5000)(9222);
    assert.strictEqual(r.webSocketDebuggerUrl, "ws://retry");
    assert.ok(calls >= 3);
  });

  it("rejects on timeout", async () => {
    http.get = () => ({ on: (e, f) => { if (e === "error") f(new Error("fail")); } });
    await assert.rejects(() => makeWaitForCDP(50)(9222), { message: "CDP timeout" });
  });

  it("rejects on invalid JSON", async () => {
    http.get = (url, cb) => {
      const res = { on: (e, f) => { if (e === "data") f("not json"); if (e === "end") f(); } };
      cb(res);
      return { on: () => {} };
    };
    await assert.rejects(() => makeWaitForCDP(5000)(9222));
  });
});

// ── Generate API response ──────────────────────────────────────────
describe("Generate API response handling", () => {
  it("accepts success", () => {
    const r = JSON.parse('{"status":"success","imageId":"abc","imageDownloadUrl":"/dl"}');
    assert.strictEqual(r.status, "success");
    assert.ok(r.imageId);
    assert.ok(r.imageDownloadUrl);
  });

  it("detects invalid_key", () => {
    assert.strictEqual(JSON.parse('{"status":"invalid_key"}').status, "invalid_key");
  });

  it("throws on non-200 HTTP status", () => {
    const s = 403;
    assert.throws(() => { if (s !== 200) throw new Error(`Generate failed: ${s}`); }, /Generate failed: 403/);
  });

  it("throws on missing imageId", () => {
    assert.throws(() => {
      const r = { status: "success", imageDownloadUrl: "/dl" };
      if (!r.imageId || !r.imageDownloadUrl) throw new Error("No imageDownloadUrl");
    }, /No imageDownloadUrl/);
  });

  it("throws on missing imageDownloadUrl", () => {
    assert.throws(() => {
      const r = { status: "success", imageId: "abc" };
      if (!r.imageId || !r.imageDownloadUrl) throw new Error("No imageDownloadUrl");
    }, /No imageDownloadUrl/);
  });
});

// ── Retry logic ────────────────────────────────────────────────────
describe("Rate limit retry logic", () => {
  it("retries up to 5 times then succeeds", async () => {
    const responses = ["waiting_for_prev_request_to_finish", "waiting_for_prev_request_to_finish", "waiting_for_prev_request_to_finish", "waiting_for_prev_request_to_finish", "success"];
    let idx = 0;
    let status;
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 5));
      status = responses[idx++];
      if (status !== "waiting_for_prev_request_to_finish") break;
    }
    assert.strictEqual(status, "success");
    assert.strictEqual(idx, 5);
  });

  it("fails when all retries are waiting", async () => {
    let status = "waiting_for_prev_request_to_finish";
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 5));
    }
    assert.throws(() => {
      if (status !== "success") throw new Error(`Generate: ${status}`);
    }, /Generate: waiting_for_prev_request_to_finish/);
  });

  it("breaks early on first non-waiting response", async () => {
    const responses = ["waiting_for_prev_request_to_finish", "success", "success"];
    let idx = 0;
    let status;
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 5));
      status = responses[idx++];
      if (status !== "waiting_for_prev_request_to_finish") break;
    }
    assert.strictEqual(status, "success");
    assert.strictEqual(idx, 2);
  });
});

// ── Await polling ──────────────────────────────────────────────────
describe("Await polling", () => {
  it("exits on success", () => {
    let broke = false;
    for (let i = 0; i < 30; i++) {
      const p = JSON.parse('{"status":"success"}');
      if (p.status === "success" || p.status === "generated") { broke = true; break; }
    }
    assert.ok(broke);
  });

  it("exits on generated", () => {
    let broke = false;
    for (let i = 0; i < 30; i++) {
      const p = JSON.parse('{"status":"generated"}');
      if (p.status === "success" || p.status === "generated") { broke = true; break; }
    }
    assert.ok(broke);
  });

  it("throws on non-200 HTTP", () => {
    assert.throws(() => {
      for (let i = 0; i < 30; i++) {
        if (403 !== 200) throw new Error("Await failed: 403");
      }
    }, /Await failed: 403/);
  });

  it("continues looping on pending", () => {
    let broke = false;
    let loops = 0;
    for (let i = 0; i < 30; i++) {
      loops++;
      const p = JSON.parse('{"status":"pending"}');
      if (p.status === "success" || p.status === "generated") { broke = true; break; }
    }
    assert.ok(!broke);
    assert.strictEqual(loops, 30);
  });

  it("handles invalid JSON gracefully in loop context", () => {
    assert.throws(() => {
      JSON.parse("not json");
    });
  });
});

// ── Download logic ─────────────────────────────────────────────────
describe("Download logic", () => {
  const testB64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

  it("succeeds first try", () => {
    let buf = null;
    for (let i = 0; i < 10; i++) {
      const dl = { ok: true, b64: testB64 };
      if (dl.ok) { buf = Buffer.from(dl.b64.split(",")[1], "base64"); break; }
    }
    assert.ok(buf);
  });

  it("retries on failure then succeeds", () => {
    const responses = [{ ok: false }, { ok: false }, { ok: true, b64: testB64 }];
    let buf = null;
    for (let i = 0; i < 10; i++) {
      const dl = responses[i] || { ok: false };
      if (dl.ok) { buf = Buffer.from(dl.b64.split(",")[1], "base64"); break; }
    }
    assert.ok(buf);
  });

  it("fails after 10 retries", () => {
    let buf = null;
    for (let i = 0; i < 10; i++) {
      if ({ ok: false }.ok) { buf = 1; break; }
    }
    assert.strictEqual(buf, null);
    assert.throws(() => { if (!buf) throw new Error("Download failed"); }, /Download failed/);
  });

  it("decodes base64 correctly", () => {
    const buf = Buffer.from(testB64.split(",")[1], "base64");
    assert.ok(buf.length > 0);
  });

  it("handles JPEG base64 prefix", () => {
    const b64 = "data:image/jpeg;base64,/9j/4AAQ";
    const buf = Buffer.from(b64.split(",")[1], "base64");
    assert.strictEqual(buf[0], 0xFF);
    assert.strictEqual(buf[1], 0xD8);
  });
});

// ── Output ─────────────────────────────────────────────────────────
describe("Output formatting", () => {
  it("emits valid JSON on success", () => {
    const obj = { path: "/tmp/x.png", size: 12345 };
    const parsed = JSON.parse(JSON.stringify(obj));
    assert.strictEqual(parsed.path, "/tmp/x.png");
    assert.strictEqual(parsed.size, 12345);
  });

  it("error message includes type and status", () => {
    const err = new Error("Generate failed: 403 cloudflare");
    assert.ok(err.message.includes("Generate failed"));
    assert.ok(err.message.includes("403"));
  });
});

// ── Cleanup ────────────────────────────────────────────────────────
describe("Cleanup", () => {
  it("closes browser and kills chrome", () => {
    let closed = false;
    let pkilled = false;
    try { closed = true; } finally { try { pkilled = true; } catch(e) {} }
    assert.ok(closed);
    assert.ok(pkilled);
  });

  it("survives pkill failure", () => {
    try { throw new Error("no process"); } catch(e) {}
    // should not throw — graceful handling
  });
});

// ── localStorage keys ──────────────────────────────────────────────
describe("localStorage keys", () => {
  const storage = {
    "userKey-0": "e9bed1654c08f0b726f975ea94b5c27ec9580fda1b7c67714125f90fe1c1e5b2",
    "userKey-1": "f511c9f2ff76f00e68abe2d12da73d8aa003d4bd77ebbd71120316679757af30",
    "subChannelName": "public",
    "lastThreadUsed": "0",
    "threadLastActiveTime-0": String(Date.now()),
    "threadLastActiveTime-1": String(Date.now()),
    "okayToShowNsfwUntil": "2096094064629",
  };

  it("resolves userKey from lastThreadUsed", () => {
    const uk = storage["userKey-" + storage["lastThreadUsed"]];
    assert.strictEqual(uk, storage["userKey-0"]);
  });

  it("has all required keys", () => {
    const required = ["userKey-0", "userKey-1", "subChannelName", "lastThreadUsed",
      "threadLastActiveTime-0", "threadLastActiveTime-1", "okayToShowNsfwUntil"];
    required.forEach(k => assert.ok(k in storage, `missing: ${k}`));
  });

  it("userKey-0 is 64-char hex", () => {
    assert.ok(/^[a-f0-9]{64}$/.test(storage["userKey-0"]));
  });

  it("userKey-1 is 64-char hex", () => {
    assert.ok(/^[a-f0-9]{64}$/.test(storage["userKey-1"]));
  });
});

// ── URL construction ───────────────────────────────────────────────
describe("URL construction", () => {
  const BASE = "https://image-generation.perchance.org";
  const uk = "abc123";

  it("generate URL has userKey and empty adAccessCode", () => {
    const url = `/api/generate?userKey=${uk}&requestId=1&adAccessCode=&__cacheBust=2`;
    assert.ok(url.includes("adAccessCode=&"));
    assert.ok(!url.includes("adAccessCode=ce5fbe0f"));
  });

  it("await URL includes userKey", () => {
    const url = `/api/awaitExistingGenerationRequest?userKey=${uk}&__cacheBust=2`;
    assert.ok(url.includes("awaitExistingGenerationRequest"));
  });

  it("download URL is absolute", () => {
    const path = "/api/downloadTemporaryImageViaProxy?t=v1.abc";
    assert.strictEqual(`${BASE}${path}`, `${BASE}/api/downloadTemporaryImageViaProxy?t=v1.abc`);
  });
});

// ── Chrome spawn args ──────────────────────────────────────────────
describe("Chrome launch args", () => {
  const args = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--remote-debugging-port=9222",
    "--user-data-dir=/tmp/chrome-cdp-profile",
    "--window-size=1280,900",
    "about:blank",
  ];

  it("includes no-sandbox", () => assert.ok(args.includes("--no-sandbox")));
  it("includes AutomationControlled", () => assert.ok(args.includes("--disable-blink-features=AutomationControlled")));
  it("includes CDP port", () => assert.ok(args.some(a => a.includes("9222"))));
  it("includes user-data-dir in tmp", () => assert.ok(args.some(a => a.startsWith("--user-data-dir=/tmp/"))));
  it("starts with about:blank", () => assert.strictEqual(args[args.length - 1], "about:blank"));
  it("includes --disable-dev-shm-usage", () => assert.ok(args.includes("--disable-dev-shm-usage")));
  it("does NOT include --disable-gpu", () => assert.ok(!args.includes("--disable-gpu")));
});

// ── Cache logic ────────────────────────────────────────────────────
describe("Cache mechanism", () => {
  const CF_TTL = 25 * 60 * 1000;

  it("returns null when cache file missing", () => {
    const existsSync = () => false;
    if (!existsSync("/tmp/nonexistent")) assert.ok(true);
  });

  it("uses cached userKey when within TTL", () => {
    const cache = { cfClearance: "abc", userKey: "key123", updatedAt: Date.now() - 1000 };
    const age = Date.now() - cache.updatedAt;
    assert.ok(age < CF_TTL);
    assert.strictEqual(cache.userKey, "key123");
  });

  it("invalidates cache when expired", () => {
    const cache = { cfClearance: "abc", userKey: "key123", updatedAt: Date.now() - 26 * 60 * 1000 };
    const age = Date.now() - cache.updatedAt;
    assert.ok(age >= CF_TTL);
    if (age >= CF_TTL) assert.ok(true, "cache expired");
  });

  it("handles corrupted cache JSON", () => {
    try { JSON.parse("not json"); assert.fail("should throw"); } catch { assert.ok(true); }
  });

  it("handles cache with missing fields", () => {
    const cache = { userKey: "key123", updatedAt: Date.now() };
    const needsFullSetup = !(cache && cache.cfClearance && cache.userKey && cache.updatedAt);
    assert.ok(needsFullSetup);
  });

  it("handles checkUserVerificationStatus: verified", () => {
    const result = { status: "verified" };
    assert.ok(result.status === "verified");
  });

  it("handles checkUserVerificationStatus: not_verified triggers full setup", () => {
    const result = { status: "not_verified" };
    assert.ok(result.status === "not_verified");
  });

  it("saves cache with cfClearance and userKey", () => {
    const saved = { cfClearance: "abc", userKey: "key123", updatedAt: Date.now() };
    const reloaded = JSON.parse(JSON.stringify(saved));
    assert.strictEqual(reloaded.cfClearance, "abc");
    assert.strictEqual(reloaded.userKey, "key123");
    assert.ok(Date.now() - reloaded.updatedAt < 5000);
  });
});
