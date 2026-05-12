"use client";

import { useState, useTransition } from "react";
import { runLLMSmoke, type LLMSmokeResult } from "./actions";

type Choice = "auto" | "gemini" | "groq";

export default function LLMTestPage() {
  const [result, setResult] = useState<LLMSmokeResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState<Choice>("auto");

  function fire() {
    setResult(null);
    startTransition(async () => {
      const r = await runLLMSmoke(choice);
      setResult(r);
    });
  }

  return (
    <main className="container flex min-h-screen flex-col gap-6 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">/dev/llm-test</h1>
        <p className="text-sm text-muted-foreground">
          Fires one tool call through the LLM router. Greet Tim → expect a
          say_hi tool call.
        </p>
      </header>

      <section className="flex items-center gap-3">
        <select
          value={choice}
          onChange={(e) => setChoice(e.target.value as Choice)}
          className="rounded border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="auto">auto (voice → groq, batch → gemini)</option>
          <option value="groq">force groq</option>
          <option value="gemini">force gemini</option>
        </select>
        <button
          onClick={fire}
          disabled={pending}
          className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
        >
          {pending ? "calling…" : "fire"}
        </button>
      </section>

      {result && (
        <section className="space-y-3 rounded border border-border bg-card p-4">
          <div className="flex items-center gap-3 font-mono text-xs tabular">
            <span
              className={
                result.ok
                  ? "rounded bg-green-500/15 px-2 py-0.5 text-green-500"
                  : "rounded bg-red-500/15 px-2 py-0.5 text-red-500"
              }
            >
              {result.ok ? "ok" : "fail"}
            </span>
            <span>provider: {result.provider ?? "—"}</span>
          </div>
          {result.error && (
            <pre className="overflow-x-auto rounded bg-muted p-3 font-mono text-xs">
              {result.error}
            </pre>
          )}
          {result.callsJson && (
            <div>
              <p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground">
                tool calls
              </p>
              <pre className="overflow-x-auto rounded bg-muted p-3 font-mono text-xs tabular">
                {result.callsJson}
              </pre>
            </div>
          )}
          {result.text && (
            <div>
              <p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground">
                assistant text (no tool calls)
              </p>
              <pre className="overflow-x-auto rounded bg-muted p-3 font-mono text-xs">
                {result.text}
              </pre>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
