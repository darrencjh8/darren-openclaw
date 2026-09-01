import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();

vi.mock("openai", () => ({
  default: vi.fn(() => ({
    chat: { completions: { create } },
  })),
}));

import { LLMClient } from "../src/orchestrator.js";
import { Config } from "../src/config.js";

beforeEach(() => {
  create.mockReset();
});

const requiredEnv = {
  ACTUAL_BUDGET_URL: "http://actual-api:3000",
  ACTUAL_BUDGET_PASSWORD: "test-password",
  ACTUAL_PRIMARY_BUDGET_FILE: "Darren SGD",
  ACTUAL_SECONDARY_BUDGET_FILE: "Darren MYR",
  ACTUAL_PRIMARY_CURRENCY: "SGD",
  ACTUAL_SECONDARY_CURRENCY: "MYR",
  IMAP_HOST: "imap.example.com",
  IMAP_USERNAME: "test@example.com",
  IMAP_PASSWORD: "test-password",
  NOTIFY_URL: "http://hermes:8644/webhooks/notify",
  HERMES_WEBHOOK_SECRET: "test-secret",
  DEEPSEEK_API_KEY: "deepseek-test-key",
};

function gptRouterConfig() {
  return new Config({
    ...requiredEnv,
    LLM_PROVIDER: "litellm",
    LLM_BASE_URL: "http://codex-router:4100/v1",
    LLM_MODEL: "gpt-5.6-luna",
    LLM_API_KEY: "router-local-key",
    LLM_REASONING_EFFORT: "low",
  });
}

describe("GPT-5.6 LiteLLM contract", () => {
  it("defaults LiteLLM traffic to the auto-thinking router pool", () => {
    const config = new Config({ ...requiredEnv, LLM_PROVIDER: "litellm" });

    expect(config.llmModel).toBe("auto-thinking");
    expect(config.llmFallbackModel).toBe("gpt-5.6-terra");
    expect(config.llmFinalFallbackProvider).toBe("deepseek");
  });

  it("sends GPT-5.6 Luna only supported completion parameters", async () => {
    create.mockResolvedValueOnce({ choices: [{ message: { content: "{}" } }] });
    const client = new LLMClient(gptRouterConfig());

    await client.chat([{ role: "user", content: "parse transaction" }]);

    const request = create.mock.calls[0][0];
    expect(request.model).toBe("gpt-5.6-luna");
    expect(request.temperature).toBe(1);
    expect(request).toHaveProperty("reasoning_effort", "low");
    expect(request).not.toHaveProperty("thinking");
  });

  it("keeps DeepSeek-only thinking and low temperature off GPT requests", async () => {
    create.mockResolvedValueOnce({ choices: [{ message: { content: "{}" } }] });
    const client = new LLMClient(gptRouterConfig());

    await client.chat([{ role: "user", content: "parse transaction" }], undefined, undefined, {
      reasoning: "adaptive",
    });

    const request = create.mock.calls[0][0];
    expect(request.temperature).toBe(1);
    expect(request).not.toHaveProperty("thinking");
  });

  it("falls back from Luna to Terra then DeepSeek with the final fallback credential", async () => {
    create
      .mockRejectedValueOnce(new Error("Luna unavailable"))
      .mockRejectedValueOnce(new Error("Luna unavailable"))
      .mockRejectedValueOnce(new Error("Luna unavailable"))
      .mockRejectedValueOnce(new Error("Terra unavailable"))
      .mockResolvedValueOnce({ choices: [{ message: { content: "{}" } }] });
    const client = new LLMClient(gptRouterConfig());

    await client.chat([{ role: "user", content: "parse transaction" }]);

    expect(create.mock.calls.map(([request]) => request.model)).toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-luna",
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "deepseek-v4-flash",
    ]);
    expect(create.mock.calls[4][0].temperature).toBe(0.1);
    expect(create.mock.calls[4][0].thinking).toEqual({ type: "adaptive" });
  }, 15000);
});
