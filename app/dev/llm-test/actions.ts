"use server";

import { createLLMRouter } from "@/lib/llm";
import type {
  LLMProviderName,
  LLMToolDefinition,
  LLMCompleteResult,
} from "@/lib/llm";

const SAY_HI: LLMToolDefinition = {
  name: "say_hi",
  description: "Greet someone by name.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Who to greet." },
      tone: {
        type: "string",
        description: "How to say it: 'casual' or 'formal'.",
      },
    },
    required: ["name"],
  },
};

export interface LLMSmokeResult {
  ok: boolean;
  provider: LLMProviderName | null;
  callsJson: string;
  text: string | null;
  error: string | null;
}

export async function runLLMSmoke(
  prefer: LLMProviderName | "auto",
): Promise<LLMSmokeResult> {
  const router = createLLMRouter();
  try {
    const result: LLMCompleteResult = await router.complete({
      messages: [
        {
          role: "system",
          content:
            "You are a smoke-test tool. When asked, call the say_hi tool with the name from the user message and a casual tone.",
        },
        { role: "user", content: "Greet Tim." },
      ],
      tools: [SAY_HI],
      toolChoice: "any",
      latency: prefer === "gemini" ? "batch" : "voice",
      prefer: prefer === "auto" ? undefined : prefer,
      maxTokens: 64,
    });
    return {
      ok: true,
      provider: result.provider,
      callsJson: JSON.stringify(result.calls, null, 2),
      text: result.text ?? null,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      provider: null,
      callsJson: "",
      text: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
