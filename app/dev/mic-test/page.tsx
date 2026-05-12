"use client";

import { useEffect, useRef, useState } from "react";
import { WebSpeechProvider } from "@/lib/stt";

export default function MicTestPage() {
  const providerRef = useRef<WebSpeechProvider | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [finals, setFinals] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const provider = new WebSpeechProvider();
    providerRef.current = provider;
    setSupported(provider.isSupported());
    return () => provider.stop();
  }, []);

  function startListening() {
    const provider = providerRef.current;
    if (!provider) return;
    setError(null);
    setInterim("");
    provider.start({
      onInterim: (t) => setInterim(t.text),
      onFinal: (t) => {
        setFinals((prev) => [...prev, t.text]);
        setInterim("");
      },
      onError: (err) => {
        setError(err.message);
        setListening(false);
      },
    });
    setListening(true);
  }

  function stopListening() {
    providerRef.current?.stop();
    setListening(false);
    setInterim("");
  }

  // Push-to-talk: hold space to speak.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== "Space" || e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      e.preventDefault();
      if (!listening) startListening();
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code !== "Space") return;
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      e.preventDefault();
      if (listening) stopListening();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening]);

  return (
    <main className="container flex min-h-screen flex-col gap-6 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">/dev/mic-test</h1>
        <p className="text-sm text-muted-foreground">
          Hold space (or click) to talk. Browser-native Web Speech API. Best in
          quiet rooms with clear speech.
        </p>
      </header>

      <section className="flex items-center gap-3">
        {supported === false ? (
          <span className="rounded bg-red-500/15 px-2 py-1 text-xs text-red-500">
            Web Speech API not supported in this browser — try Chrome or Edge.
          </span>
        ) : (
          <button
            onMouseDown={startListening}
            onMouseUp={stopListening}
            onMouseLeave={stopListening}
            onTouchStart={startListening}
            onTouchEnd={stopListening}
            disabled={supported === null}
            className={
              "rounded px-4 py-2 text-sm transition " +
              (listening
                ? "bg-green-500/20 text-green-500"
                : "bg-primary text-primary-foreground")
            }
          >
            {listening ? "listening…" : "hold to talk"}
          </button>
        )}
        {listening && (
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            recording
          </span>
        )}
      </section>

      {error && (
        <pre className="rounded bg-muted p-3 font-mono text-xs text-red-500">
          {error}
        </pre>
      )}

      <section className="space-y-3">
        <div>
          <p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground">
            interim
          </p>
          <pre className="min-h-[3rem] rounded border border-dashed border-border bg-card p-3 font-mono text-sm text-muted-foreground">
            {interim || "—"}
          </pre>
        </div>
        <div>
          <p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground">
            finalized utterances ({finals.length})
          </p>
          <ol className="space-y-1">
            {finals.map((f, i) => (
              <li
                key={i}
                className="rounded bg-muted p-2 font-mono text-sm tabular"
              >
                {f}
              </li>
            ))}
            {finals.length === 0 && (
              <li className="text-sm text-muted-foreground">
                Nothing finalized yet.
              </li>
            )}
          </ol>
        </div>
      </section>
    </main>
  );
}
