// LLMProvider interface — one method, one job: take canonical inputs, return
// canonical outputs. Each provider implementation translates to and from its
// vendor SDK's shapes inside `complete`.

import type {
  LLMCompleteOptions,
  LLMCompleteResult,
  LLMProviderName,
} from "./types";

export interface LLMProvider {
  readonly name: LLMProviderName;
  complete(opts: LLMCompleteOptions): Promise<LLMCompleteResult>;
}
