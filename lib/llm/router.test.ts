// Router unit tests — no network. The providers are stubs that record calls
// and let us simulate 429s and other failures.

import { describe, it, expect } from "vitest";
import { LLMRouter } from "./router";
import type { LLMProvider } from "./provider";
import {
  LLMProviderError,
  type LLMCompleteOptions,
  type LLMCompleteResult,
  type LLMProviderName,
} from "./types";

class StubProvider implements LLMProvider {
  readonly name: LLMProviderName;
  calls = 0;
  shouldThrow: { status?: number; once?: boolean } | null = null;

  constructor(name: LLMProviderName) {
    this.name = name;
  }

  async complete(_opts: LLMCompleteOptions): Promise<LLMCompleteResult> {
    this.calls++;
    if (this.shouldThrow) {
      const { status, once } = this.shouldThrow;
      if (once) this.shouldThrow = null;
      throw new LLMProviderError("stub failure", null, this.name, status);
    }
    return {
      provider: this.name,
      calls: [{ name: "ok", args: { from: this.name } }],
    };
  }
}

function makeProvidersAndRouter(now: number = 0) {
  const gemini = new StubProvider("gemini");
  const groq = new StubProvider("groq");
  let t = now;
  const router = new LLMRouter(
    { gemini, groq },
    { now: () => t, cooldownMs: 60_000 },
  );
  return {
    gemini,
    groq,
    router,
    advance(ms: number) {
      t += ms;
    },
  };
}

const baseOpts: LLMCompleteOptions = { messages: [], tools: [] };

describe("LLMRouter.selectOrder", () => {
  it("voice latency prefers groq", () => {
    const { router } = makeProvidersAndRouter();
    expect(router.selectOrder({ latency: "voice" })).toEqual(["groq", "gemini"]);
  });

  it("batch latency prefers gemini", () => {
    const { router } = makeProvidersAndRouter();
    expect(router.selectOrder({ latency: "batch" })).toEqual([
      "gemini",
      "groq",
    ]);
  });

  it("explicit prefer overrides latency", () => {
    const { router } = makeProvidersAndRouter();
    expect(
      router.selectOrder({ latency: "voice", prefer: "gemini" }),
    ).toEqual(["gemini", "groq"]);
  });

  it("cooling-down provider is demoted to last", () => {
    const { router } = makeProvidersAndRouter();
    router.markRateLimited("groq");
    expect(router.selectOrder({ latency: "voice" })).toEqual([
      "gemini",
      "groq",
    ]);
  });
});

describe("LLMRouter.complete", () => {
  it("calls the preferred provider first and short-circuits on success", async () => {
    const { router, gemini, groq } = makeProvidersAndRouter();
    const result = await router.complete({ ...baseOpts, latency: "voice" });
    expect(result.provider).toBe("groq");
    expect(groq.calls).toBe(1);
    expect(gemini.calls).toBe(0);
  });

  it("falls through to the second provider on a generic failure", async () => {
    const { router, gemini, groq } = makeProvidersAndRouter();
    groq.shouldThrow = { status: 500 };
    const result = await router.complete({ ...baseOpts, latency: "voice" });
    expect(result.provider).toBe("gemini");
    expect(groq.calls).toBe(1);
    expect(gemini.calls).toBe(1);
  });

  it("marks a provider rate-limited on 429 and uses the fallback", async () => {
    const { router, groq } = makeProvidersAndRouter();
    groq.shouldThrow = { status: 429 };
    const result = await router.complete({ ...baseOpts, latency: "voice" });
    expect(result.provider).toBe("gemini");
    expect(router.isCoolingDown("groq")).toBe(true);
  });

  it("after a 429, subsequent calls skip the cooling provider entirely", async () => {
    const { router, gemini, groq } = makeProvidersAndRouter();
    groq.shouldThrow = { status: 429, once: true };
    await router.complete({ ...baseOpts, latency: "voice" });
    groq.calls = 0;
    gemini.calls = 0;
    const result = await router.complete({ ...baseOpts, latency: "voice" });
    expect(result.provider).toBe("gemini");
    expect(groq.calls).toBe(0); // skipped — still cooling
    expect(gemini.calls).toBe(1);
  });

  it("a cooldown lifts after the configured duration passes", async () => {
    const { router, gemini, groq, advance } = makeProvidersAndRouter();
    router.markRateLimited("groq");
    advance(60_001);
    const result = await router.complete({ ...baseOpts, latency: "voice" });
    expect(result.provider).toBe("groq");
    expect(groq.calls).toBe(1);
    expect(gemini.calls).toBe(0);
  });

  it("throws LLMProviderError when every provider fails", async () => {
    const { router, gemini, groq } = makeProvidersAndRouter();
    groq.shouldThrow = { status: 500 };
    gemini.shouldThrow = { status: 500 };
    await expect(
      router.complete({ ...baseOpts, latency: "voice" }),
    ).rejects.toBeInstanceOf(LLMProviderError);
  });
});
