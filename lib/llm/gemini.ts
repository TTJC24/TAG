// Gemini provider — wraps @google/generative-ai. Primary for batch workloads
// (transcript ingestion). Free tier 1,500 req/day.

import {
  GoogleGenerativeAI,
  SchemaType,
  FunctionCallingMode,
  type FunctionDeclarationSchema,
} from "@google/generative-ai";
import type { LLMProvider } from "./provider";
import {
  type LLMCompleteOptions,
  type LLMCompleteResult,
  type LLMMessage,
  type LLMToolChoice,
  type LLMToolDefinition,
  LLMProviderError,
} from "./types";

export interface GeminiProviderConfig {
  apiKey: string;
  /** Model id. Defaults to gemini-2.5-flash (free tier). */
  model?: string;
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini" as const;
  private readonly client: GoogleGenerativeAI;
  private readonly model: string;

  constructor(cfg: GeminiProviderConfig) {
    this.client = new GoogleGenerativeAI(cfg.apiKey);
    this.model = cfg.model ?? "gemini-2.5-flash";
  }

  async complete(opts: LLMCompleteOptions): Promise<LLMCompleteResult> {
    const { systemInstruction, contents } = toGeminiMessages(opts.messages);
    const hasTools = opts.tools.length > 0;
    const model = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction,
      tools: hasTools
        ? [{ functionDeclarations: opts.tools.map(toGeminiTool) }]
        : undefined,
      toolConfig: hasTools
        ? {
            functionCallingConfig: {
              mode: toGeminiToolChoice(opts.toolChoice),
            },
          }
        : undefined,
      generationConfig: {
        maxOutputTokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0,
      },
    });

    try {
      const result = await model.generateContent({ contents });
      const response = result.response;
      const fnCalls = response.functionCalls() ?? [];
      const calls = fnCalls.map((c) => ({
        name: c.name,
        args: (c.args ?? {}) as Record<string, unknown>,
      }));
      const text = fnCalls.length === 0 ? response.text() : undefined;
      return { provider: this.name, calls, text };
    } catch (err) {
      const status = extractStatus(err);
      throw new LLMProviderError(
        `Gemini request failed${status ? ` (HTTP ${status})` : ""}`,
        err,
        this.name,
        status,
      );
    }
  }
}

// ── translation helpers ────────────────────────────────────────────────────

function toGeminiMessages(messages: LLMMessage[]): {
  systemInstruction?: string;
  contents: { role: "user" | "model"; parts: { text: string }[] }[];
} {
  const systemMessages = messages.filter((m) => m.role === "system");
  const conversation = messages.filter((m) => m.role !== "system");
  const systemInstruction =
    systemMessages.length > 0
      ? systemMessages.map((m) => m.content).join("\n\n")
      : undefined;
  const contents = conversation.map((m) => ({
    role: m.role === "assistant" ? ("model" as const) : ("user" as const),
    parts: [{ text: m.content }],
  }));
  return { systemInstruction, contents };
}

function toGeminiToolChoice(choice: LLMToolChoice | undefined): FunctionCallingMode {
  switch (choice) {
    case "any":
      return FunctionCallingMode.ANY;
    case "none":
      return FunctionCallingMode.NONE;
    case "auto":
    case undefined:
      return FunctionCallingMode.AUTO;
  }
}

function toGeminiTool(t: LLMToolDefinition) {
  return {
    name: t.name,
    description: t.description,
    parameters: jsonSchemaToGemini(t.parameters),
  };
}

/** Recursively convert a generic JSON Schema object into Gemini's
 *  `FunctionDeclarationSchema` shape (which uses an enum for `type` and a
 *  capitalized one at that). We only handle the subset of JSON Schema we
 *  actually use in tool definitions. */
function jsonSchemaToGemini(schema: unknown): FunctionDeclarationSchema {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = schema as any;
  const type = (s?.type ?? "object") as string;
  const mapped: Record<string, SchemaType> = {
    string: SchemaType.STRING,
    number: SchemaType.NUMBER,
    integer: SchemaType.INTEGER,
    boolean: SchemaType.BOOLEAN,
    array: SchemaType.ARRAY,
    object: SchemaType.OBJECT,
  };
  const out: FunctionDeclarationSchema = {
    type: (mapped[type] ?? SchemaType.OBJECT) as FunctionDeclarationSchema["type"],
    description: s?.description,
  } as FunctionDeclarationSchema;
  if (s?.properties) {
    const props: Record<string, FunctionDeclarationSchema> = {};
    for (const [k, v] of Object.entries(s.properties)) {
      props[k] = jsonSchemaToGemini(v);
    }
    (out as { properties?: Record<string, FunctionDeclarationSchema> }).properties = props;
  }
  if (Array.isArray(s?.required)) {
    (out as { required?: string[] }).required = s.required;
  }
  if (Array.isArray(s?.enum)) {
    (out as { enum?: string[] }).enum = s.enum;
  }
  if (s?.items) {
    (out as { items?: FunctionDeclarationSchema }).items = jsonSchemaToGemini(s.items);
  }
  return out;
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const e = err as { status?: number; statusCode?: number };
    return e.status ?? e.statusCode;
  }
  return undefined;
}
