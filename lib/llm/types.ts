// Provider-agnostic LLM types. Same shape feeds Gemini's
// `functionDeclarations`, Groq's OpenAI-compatible `tools`, and any future
// provider (Claude, Ollama). See ADR-0010.

export type LLMRole = "system" | "user" | "assistant";

export interface LLMMessage {
  role: LLMRole;
  content: string;
}

/** A tool's parameter schema is a JSON Schema object. Kept loose by design — the
 * provider implementations forward it verbatim. */
export type JSONSchemaObject = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
};

export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchemaObject;
}

export interface LLMToolCall {
  name: string;
  /** Parsed object. For Groq/OpenAI the SDK returns a JSON string; the
   *  provider implementation parses it before returning. */
  args: Record<string, unknown>;
}

/** Whether the model must / may / must-not call a tool.
 *  - "auto" (default): model decides.
 *  - "any": model must call one of the provided tools.
 *  - "none": model must respond in plain text.
 *
 *  Voice and transcript paths in this product set "any" because the system
 *  prompt requires a tool call (including `clarify` when ambiguous). */
export type LLMToolChoice = "auto" | "any" | "none";

export interface LLMCompleteOptions {
  messages: LLMMessage[];
  tools: LLMToolDefinition[];
  /** Default "auto". */
  toolChoice?: LLMToolChoice;
  /** Hard cap on response size. Sensible default per provider. */
  maxTokens?: number;
  /** Default 0 for deterministic tool-call behavior. */
  temperature?: number;
}

export type LLMProviderName = "gemini" | "groq";

export interface LLMCompleteResult {
  provider: LLMProviderName;
  calls: LLMToolCall[];
  /** Free-text assistant content, if any was emitted alongside tool calls. */
  text?: string;
}

/** Thrown when every candidate provider rejected the request. */
export class LLMProviderError extends Error {
  public readonly provider?: LLMProviderName;
  public readonly status?: number;
  constructor(
    message: string,
    cause?: unknown,
    provider?: LLMProviderName,
    status?: number,
  ) {
    super(message, { cause });
    this.name = "LLMProviderError";
    this.provider = provider;
    this.status = status;
  }
}
