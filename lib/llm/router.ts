// LLM router — picks a provider based on latency requirement and per-provider
// rate-limit state. In-memory state per server process; that's fine for v1.
// Treat HTTP 429 as a temporary signal to flip to the other provider.

import type { LLMProvider } from "./provider";
import {
  type LLMCompleteOptions,
  type LLMCompleteResult,
  type LLMProviderName,
  LLMProviderError,
} from "./types";

export type LatencyMode = "voice" | "batch";

export interface RouterOptions {
  /** voice → Groq preferred (latency); batch → Gemini preferred (quota). */
  latency: LatencyMode;
  /** Caller override — bypasses the latency-based default. */
  prefer?: LLMProviderName;
}

interface RateLimitCache {
  /** Epoch ms until which this provider is considered rate-limited. */
  cooldownUntil: number;
}

/** Default cooldown after a 429. Short enough to recover within a meeting,
 *  long enough to avoid hammering. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

export class LLMRouter {
  private readonly providers: Record<LLMProviderName, LLMProvider>;
  private readonly rate: Record<LLMProviderName, RateLimitCache> = {
    gemini: { cooldownUntil: 0 },
    groq: { cooldownUntil: 0 },
  };
  private readonly now: () => number;
  private readonly cooldownMs: number;

  constructor(
    providers: { gemini: LLMProvider; groq: LLMProvider },
    opts: { now?: () => number; cooldownMs?: number } = {},
  ) {
    this.providers = providers;
    this.now = opts.now ?? (() => Date.now());
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  }

  /** Order providers by preference + rate-limit state. Returns the candidate
   *  list to attempt in order. */
  selectOrder(opts: RouterOptions): LLMProviderName[] {
    const baseOrder: LLMProviderName[] =
      opts.prefer === "gemini"
        ? ["gemini", "groq"]
        : opts.prefer === "groq"
          ? ["groq", "gemini"]
          : opts.latency === "voice"
            ? ["groq", "gemini"]
            : ["gemini", "groq"];

    // Demote any provider currently in cooldown.
    const ready: LLMProviderName[] = [];
    const cooling: LLMProviderName[] = [];
    const now = this.now();
    for (const name of baseOrder) {
      if (this.rate[name].cooldownUntil > now) cooling.push(name);
      else ready.push(name);
    }
    return [...ready, ...cooling];
  }

  isCoolingDown(name: LLMProviderName): boolean {
    return this.rate[name].cooldownUntil > this.now();
  }

  /** Test helper — bypass the timer and force a cooldown. */
  markRateLimited(name: LLMProviderName, durationMs?: number): void {
    this.rate[name].cooldownUntil =
      this.now() + (durationMs ?? this.cooldownMs);
  }

  async complete(
    opts: LLMCompleteOptions & RouterOptions,
  ): Promise<LLMCompleteResult> {
    const order = this.selectOrder(opts);
    const errors: { provider: LLMProviderName; err: unknown }[] = [];

    for (const name of order) {
      const provider = this.providers[name];
      try {
        return await provider.complete(opts);
      } catch (err) {
        const status =
          err instanceof LLMProviderError ? err.status : undefined;
        if (status === 429) {
          this.markRateLimited(name);
        }
        errors.push({ provider: name, err });
      }
    }

    const summary = errors
      .map((e) =>
        e.err instanceof LLMProviderError
          ? `${e.provider}:${e.err.status ?? "?"}`
          : `${e.provider}:err`,
      )
      .join(", ");
    throw new LLMProviderError(
      `all providers failed (${summary})`,
      errors,
    );
  }
}
