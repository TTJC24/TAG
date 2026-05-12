// Web Speech API STT provider. Browser-only. Privacy note: Chrome's
// implementation routes audio through Google's servers.
//
// To swap in local Whisper or Deepgram later, write a new class that
// implements STTProvider — call sites pass through the interface, not the
// concrete class. See ADR-0010.

import type { STTProvider, STTStartOptions } from "./types";

// Browser-only types: SpeechRecognition isn't in the TS DOM lib by default
// across all targets, so we declare a structural subset here.
interface MinimalSpeechRecognitionResult {
  isFinal: boolean;
  readonly length: number;
  [index: number]: { transcript: string };
}
interface MinimalSpeechRecognitionResultList {
  readonly length: number;
  [index: number]: MinimalSpeechRecognitionResult;
}
interface MinimalSpeechRecognitionEvent {
  resultIndex: number;
  results: MinimalSpeechRecognitionResultList;
}
interface MinimalSpeechRecognitionErrorEvent {
  error: string;
  message?: string;
}
interface MinimalSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: MinimalSpeechRecognitionEvent) => void) | null;
  onerror: ((ev: MinimalSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
interface MinimalSpeechRecognitionCtor {
  new (): MinimalSpeechRecognition;
}

function getRecognitionCtor(): MinimalSpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: MinimalSpeechRecognitionCtor;
    webkitSpeechRecognition?: MinimalSpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export class WebSpeechProvider implements STTProvider {
  readonly name = "web-speech" as const;
  private rec: MinimalSpeechRecognition | null = null;

  isSupported(): boolean {
    return getRecognitionCtor() !== null;
  }

  start(opts: STTStartOptions): void {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      opts.onError?.(
        new Error(
          "Web Speech API not available in this browser. Try Chrome or Edge.",
        ),
      );
      return;
    }
    if (this.rec) {
      // Already running — make stop idempotent and restart cleanly.
      this.stop();
    }
    const rec = new Ctor();
    rec.lang = opts.lang ?? "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        if (!result) continue;
        const first = result[0];
        if (!first) continue;
        const payload = { text: first.transcript, isFinal: result.isFinal };
        if (result.isFinal) {
          opts.onFinal(payload);
        } else {
          opts.onInterim?.(payload);
        }
      }
    };
    rec.onerror = (ev) => {
      opts.onError?.(
        new Error(`Web Speech error: ${ev.error}${ev.message ? ` — ${ev.message}` : ""}`),
      );
    };
    rec.onend = () => {
      this.rec = null;
    };
    rec.start();
    this.rec = rec;
  }

  stop(): void {
    if (!this.rec) return;
    try {
      this.rec.stop();
    } catch {
      // ignore — already stopped
    }
    this.rec = null;
  }
}
