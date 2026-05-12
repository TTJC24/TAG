// Groq provider — wraps groq-sdk (OpenAI-compatible). Primary for voice
// (latency-sensitive). Free tier 14,400 req/day.

import Groq from "groq-sdk";
import type { LLMProvider } from "./provider";
import {
  type LLMCompleteOptions,
  type LLMCompleteResult,
  LLMProviderError,
} from "./types";

export interface GroqProviderConfig {
  apiKey: string;
  /** Model id. Defaults to llama-3.3-70b-versatile. */
  model?: string;
}

export class GroqProvider implements LLMProvider {
  readonly name = "groq" as const;
  private readonly client: Groq;
  private readonly model: string;

  constructor(cfg: GroqProviderConfig) {
    this.client = new Groq({ apiKey: cfg.apiKey });
    this.model = cfg.model ?? "llama-3.3-70b-versatile";
  }

  async complete(opts: LLMCompleteOptions): Promise<LLMCompleteResult> {
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
        tools:
          opts.tools.length > 0
            ? opts.tools.map((t) => ({
                type: "function" as const,
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters as Record<string, unknown>,
                },
              }))
            : undefined,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0,
      });
      const choice = res.choices[0];
      if (!choice) return { provider: this.name, calls: [] };

      const calls = (choice.message.tool_calls ?? []).map((tc) => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(tc.function.arguments || "{}");
        } catch {
          parsed = { _raw: tc.function.arguments };
        }
        return { name: tc.function.name, args: parsed };
      });
      const text =
        calls.length === 0 ? (choice.message.content ?? undefined) : undefined;
      return { provider: this.name, calls, text: text ?? undefined };
    } catch (err) {
      const status = extractStatus(err);
      throw new LLMProviderError(
        `Groq request failed${status ? ` (HTTP ${status})` : ""}`,
        err,
        this.name,
        status,
      );
    }
  }
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const e = err as { status?: number; statusCode?: number };
    return e.status ?? e.statusCode;
  }
  return undefined;
}
