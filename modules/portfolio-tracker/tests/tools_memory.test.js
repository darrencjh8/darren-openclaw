/**
 * Task 4 tests (#88): search_memory / learn_fact dispatch, password passthrough
 * to the extractors, and password redaction in tool-execution logs.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const ex = vi.hoisted(() => ({ pdfPw: [], emailPw: [] }));

vi.mock("../src/pdf_extractor.js", () => ({
  extractPdfText: vi.fn(async (_b, password = null) => {
    ex.pdfPw.push(password);
    return "PDF TEXT";
  }),
}));
vi.mock("../src/email_handler.js", () => ({
  extractEmailContent: vi.fn(async (_r, password = null) => {
    ex.emailPw.push(password);
    return "EMAIL TEXT";
  }),
  classifyEmail: vi.fn(),
}));

import { ToolRegistry } from "../src/tools.js";

function makeRegistry(factsMemory) {
  // dedup/memory/ppBridge are unused by the tools under test
  return new ToolRegistry({}, null, null, null, null, factsMemory);
}

beforeEach(() => {
  ex.pdfPw = [];
  ex.emailPw = [];
  vi.clearAllMocks();
});

describe("ToolRegistry — memory tools", () => {
  it("search_memory delegates to FactsMemory.search", async () => {
    const facts = {
      search: vi.fn(async (q) => [{ text: `hit:${q}`, score: 1 }]),
      add: vi.fn(),
    };
    const reg = makeRegistry(facts);
    const res = await reg.executeTool("search_memory", { query: "IBKR" });
    expect(facts.search).toHaveBeenCalledWith("IBKR");
    expect(res.results[0].text).toBe("hit:IBKR");
  });

  it("learn_fact delegates to FactsMemory.add", async () => {
    const facts = {
      search: vi.fn(),
      add: vi.fn(async () => ({ added: true })),
    };
    const reg = makeRegistry(facts);
    const res = await reg.executeTool("learn_fact", {
      fact: "POEMS password is x",
    });
    expect(facts.add).toHaveBeenCalledWith("POEMS password is x");
    expect(res.added).toBe(true);
  });

  it("search_memory returns empty when no facts store is wired", async () => {
    const reg = makeRegistry(null);
    const res = await reg.executeTool("search_memory", { query: "x" });
    expect(res.results).toEqual([]);
  });
});

describe("ToolRegistry — password passthrough", () => {
  it("forwards password to extract_pdf_text", async () => {
    const reg = makeRegistry(null);
    await reg.executeTool("extract_pdf_text", {
      pdf_bytes_b64: Buffer.from("x").toString("base64"),
      password: "Secret123",
    });
    expect(ex.pdfPw).toEqual(["Secret123"]);
  });

  it("forwards password to extract_email_content", async () => {
    const reg = makeRegistry(null);
    await reg.executeTool("extract_email_content", { password: "Secret123" });
    expect(ex.emailPw).toEqual(["Secret123"]);
  });
});

describe("ToolRegistry — log redaction", () => {
  it("never writes the password value to logs", async () => {
    const logged = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s) => {
      logged.push(String(s));
    });
    const reg = makeRegistry(null);
    await reg.executeTool("extract_pdf_text", {
      pdf_bytes_b64: "AA==",
      password: "hunter2",
    });
    spy.mockRestore();
    const all = logged.join("\n");
    expect(all).not.toContain("hunter2");
    expect(all).toContain("[REDACTED]");
  });
});
