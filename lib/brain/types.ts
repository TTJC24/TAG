// Wire types for the **company-brain** integration.
//
// company-brain is an external gbrain-based knowledge base that indexes the
// FS/BLCS/USA group's operational systems — Acumatica (ERP), Pipedrive (CRM),
// and Microsoft 365 (mail / calendar / sharepoint / teams). This app is a
// client; the brain is opaque. These types describe only the wire payloads we
// send and the ones we expect back.
//
// Brain results map onto the app's existing JerryCitation shape so the Jerry
// dock can render brain provenance with no new render path. See
// `brainHitToCitation` in lib/brain/client.ts.

// ── A single search hit returned by the brain ───────────────────────────────
export interface BrainHit {
  /** Stable slug for the indexed document. */
  slug: string;
  /** Source system + record id, e.g. "acumatica:SO123" / "pipedrive:deal/88". */
  source_id: string;
  /** Human-readable document/record title. */
  title: string;
  /** The matched chunk of text. */
  chunk_text: string;
}

// ── POST /search response ────────────────────────────────────────────────────
export interface BrainSearchResult {
  hits: BrainHit[];
}

// ── A single citation returned by /ask ───────────────────────────────────────
export interface BrainAskCitation {
  slug: string;
  source_id: string;
  title: string;
}

// ── POST /ask response ────────────────────────────────────────────────────────
export interface BrainAskResult {
  text: string;
  citations: BrainAskCitation[];
}

// ── GET /sources response ─────────────────────────────────────────────────────
export interface BrainSourcesResult {
  /** e.g. ["acumatica","pipedrive","m365-mail","m365-calendar",
   *        "m365-sharepoint","m365-teams"]. */
  sources: string[];
}

// ── GET /health response ──────────────────────────────────────────────────────
export interface BrainHealthResult {
  ok: boolean;
  time?: string;
}
