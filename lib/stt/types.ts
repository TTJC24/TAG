// STT provider types. Web Speech API is the v1 implementation; local Whisper
// and Deepgram will land later behind the same interface (ADR-0010).

export type STTProviderName = "web-speech" | "local-whisper" | "deepgram";

export interface STTTranscript {
  text: string;
  /** true = the engine has finalized this utterance. */
  isFinal: boolean;
}

export interface STTStartOptions {
  /** Fired on every interim transcript while the user is still speaking. */
  onInterim?: (t: STTTranscript) => void;
  /** Fired once per finalized utterance. */
  onFinal: (t: STTTranscript) => void;
  /** Fired on engine errors (no permission, no network, unsupported, etc.). */
  onError?: (err: Error) => void;
  /** BCP-47 lang code; defaults to "en-US". */
  lang?: string;
}

export interface STTProvider {
  readonly name: STTProviderName;
  /** Returns true if this provider can run in the current environment. */
  isSupported(): boolean;
  start(opts: STTStartOptions): void;
  stop(): void;
}
