// LLM public surface — callers import from `@/lib/llm`.
//
// `createLLMRouter()` wires the two providers from env. Server-side only;
// do not import from client components.

import { requireEnv } from "@/lib/env";
import { GeminiProvider } from "./gemini";
import { GroqProvider } from "./groq";
import { LLMRouter } from "./router";

export type {
  LLMMessage,
  LLMToolDefinition,
  LLMToolCall,
  LLMCompleteOptions,
  LLMCompleteResult,
  LLMProviderName,
  JSONSchemaObject,
} from "./types";
export { LLMProviderError } from "./types";
export type { LLMProvider } from "./provider";
export { GeminiProvider } from "./gemini";
export { GroqProvider } from "./groq";
export {
  LLMRouter,
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  type LatencyMode,
  type RouterOptions,
} from "./router";

let _singleton: LLMRouter | null = null;

/** Process-singleton router. Reads keys from env on first call.
 *  Tests should construct an LLMRouter directly with stub providers. */
export function createLLMRouter(): LLMRouter {
  if (_singleton) return _singleton;
  _singleton = new LLMRouter({
    gemini: new GeminiProvider({ apiKey: requireEnv("GOOGLE_AI_API_KEY") }),
    groq: new GroqProvider({ apiKey: requireEnv("GROQ_API_KEY") }),
  });
  return _singleton;
}
