import { z } from "zod";
import type { DatabasePool } from "@operating-layer/db";
import { DomainError } from "./errors.js";
import { resolveApplicationPrincipal } from "./identity.js";
import { createManualIssue } from "./service.js";

/**
 * DemandStar bid doorway: municipal revenue enters governed intake.
 *
 * DemandStar announcements and deadline reminders arrive as email (source
 * SRC-USA-DEMANDSTAR-001 in the WorkOS source registry). Each bid becomes a
 * governed issue — classified, recommended, approval-gated, tracked to done —
 * with the response deadline as the task due date so the queue and brief
 * surface closing bids automatically.
 *
 * Posture:
 * - Input is exported message data (JSON), parsed deterministically — no
 *   model guesses at bid numbers, agencies, or deadlines. Unparseable or
 *   non-bid messages are skipped and reported, never invented.
 * - Only messages from an allow-listed sender domain are considered.
 * - Idempotency key `demandstar:<bidNumber>`: announcement and reminder for
 *   the same bid converge on one issue; re-runs replay.
 * - Inert by default; enabling requires explicit configuration, and the
 *   provenance rule from the source registry (bid number + issuing agency +
 *   announcement date) is embedded in every task description.
 */

export const demandstarMessageSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  from: z.string().min(1),
  date: z.string().min(1),
  body: z.string().min(1),
});
export type DemandstarMessage = z.infer<typeof demandstarMessageSchema>;

export const demandstarMessagesFileSchema = z.object({
  messages: z.array(demandstarMessageSchema).min(1),
});

export interface ParsedBid {
  kind: "announcement" | "deadline_reminder";
  bidNumber: string;
  bidName: string | null;
  agency: string | null;
  agencyLocation: string | null;
  scope: string | null;
  dueDate: string | null; // YYYY-MM-DD
  dueText: string | null; // original wording, kept for provenance
}

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(tr|td|p|div|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function extractDate(text: string): { iso: string; raw: string } | null {
  // "September 10, 2026 3:00 PM (Eastern)"
  const longMatch = text.match(
    /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})(?:\s+\d{1,2}:\d{2}\s*[AP]M)?/,
  );
  if (longMatch) {
    const month = MONTHS[longMatch[1]!.toLowerCase()];
    if (month) {
      return {
        iso: `${longMatch[3]}-${month}-${longMatch[2]!.padStart(2, "0")}`,
        raw: longMatch[0]!,
      };
    }
  }
  // "07/28/2026 1:45 PM Eastern"
  const shortMatch = text.match(
    /(\d{2})\/(\d{2})\/(\d{4})(?:\s+\d{1,2}:\d{2}\s*[AP]M)?/,
  );
  if (shortMatch) {
    return {
      iso: `${shortMatch[3]}-${shortMatch[1]}-${shortMatch[2]}`,
      raw: shortMatch[0]!,
    };
  }
  return null;
}

function field(text: string, label: string): string | null {
  const match = text.match(new RegExp(`${label}\\s*:?\\s*\\n?([^\\n]+)`, "i"));
  const value = match?.[1]?.trim() ?? null;
  return value && value.length > 0 ? value : null;
}

/**
 * Deterministically parse one DemandStar message. Returns null for messages
 * that are not a bid announcement or deadline reminder (e.g. award notices).
 */
export function parseDemandstarMessage(
  message: DemandstarMessage,
): ParsedBid | null {
  const isAnnouncement = /^Announcing Bid\s/i.test(message.subject);
  const isReminder = /Response deadline is approaching/i.test(message.subject);
  if (!isAnnouncement && !isReminder) {
    return null;
  }

  let text = htmlToText(message.body);
  // Announcements append a "you may also be interested" recommendations
  // block with its own bid fields; cut before extracting the primary bid.
  const recommendationsAt = text.search(/You may also be interested/i);
  if (recommendationsAt >= 0) {
    text = text.slice(0, recommendationsAt);
  }

  const bidNumber = field(text, "Bid Identifier");
  if (!bidNumber) {
    return null;
  }

  const dueLine = isReminder
    ? (text.match(/reminder that\s+([^\n]+?)\s+is the deadline/i)?.[1] ?? null)
    : field(text, "Responses due by");
  const due = dueLine ? extractDate(dueLine) : null;

  return {
    kind: isAnnouncement ? "announcement" : "deadline_reminder",
    bidNumber,
    bidName: field(text, "Bid Name"),
    agency: field(text, "Agency"),
    agencyLocation: field(text, "Agency Location"),
    scope: field(text, "Scope of work"),
    dueDate: due?.iso ?? null,
    dueText: dueLine,
  };
}

export interface DemandstarBridgeEnv {
  DEMANDSTAR_BRIDGE_ENABLED?: string;
  DEMANDSTAR_BRIDGE_USER_EMAIL?: string;
  DEMANDSTAR_BRIDGE_ENTITY_CODE?: string;
  DEMANDSTAR_BRIDGE_SENDER_DOMAIN?: string;
}

export interface DemandstarBridgeConfig {
  serviceUserEmail: string;
  entityCode: string;
  senderDomain: string;
}

export function resolveDemandstarBridgeConfig(
  env: DemandstarBridgeEnv = process.env as DemandstarBridgeEnv,
): DemandstarBridgeConfig {
  if (env.DEMANDSTAR_BRIDGE_ENABLED !== "true") {
    throw new DomainError(
      409,
      "demandstar_bridge_disabled",
      "The DemandStar bridge is disabled; set DEMANDSTAR_BRIDGE_ENABLED=true explicitly",
    );
  }
  if (!env.DEMANDSTAR_BRIDGE_USER_EMAIL) {
    throw new Error(
      "DEMANDSTAR_BRIDGE_ENABLED requires DEMANDSTAR_BRIDGE_USER_EMAIL",
    );
  }
  return {
    serviceUserEmail: env.DEMANDSTAR_BRIDGE_USER_EMAIL,
    entityCode: env.DEMANDSTAR_BRIDGE_ENTITY_CODE ?? "USA",
    senderDomain: env.DEMANDSTAR_BRIDGE_SENDER_DOMAIN ?? "demandstar.com",
  };
}

export interface DemandstarSyncSkip {
  messageId: string;
  reason: string;
}

export interface DemandstarSyncResult {
  scanned: number;
  created: number;
  replayed: number;
  skipped: DemandstarSyncSkip[];
}

function clampText(value: string, minimum: number, maximum: number): string {
  const trimmed = value.trim();
  const padded =
    trimmed.length >= minimum ? trimmed : trimmed.padEnd(minimum, ".");
  return padded.slice(0, maximum);
}

function describeBid(bid: ParsedBid, message: DemandstarMessage): string {
  const lines = [
    `Municipal bid via DemandStar (source SRC-USA-DEMANDSTAR-001).`,
    `Bid number: ${bid.bidNumber}`,
    bid.bidName ? `Bid name: ${bid.bidName}` : null,
    bid.agency ? `Issuing agency: ${bid.agency}` : null,
    bid.agencyLocation ? `Agency location: ${bid.agencyLocation}` : null,
    bid.dueText ? `Responses due: ${bid.dueText}` : null,
    bid.scope ? `Scope: ${bid.scope}` : null,
    `Announced: ${message.date} (message ${message.id}, kind ${bid.kind}).`,
    `Pipedrive is canonical for pursuit state: check for an existing deal before acting, and record the bid/no-bid decision there. This task tracks that the decision happens before the deadline; it does not duplicate deal state.`,
  ].filter((line): line is string => line !== null);
  return clampText(lines.join("\n"), 3, 10_000);
}

/**
 * Feed exported DemandStar messages through governed intake. Re-runs are
 * idempotent per bid number; a reminder for an already-synced bid replays it.
 */
export async function syncDemandstarBids(
  operatingPool: DatabasePool,
  messages: DemandstarMessage[],
  config: DemandstarBridgeConfig,
  organizationIdsByCode: Record<string, string>,
): Promise<DemandstarSyncResult> {
  const organizationId = organizationIdsByCode[config.entityCode];
  if (!organizationId) {
    throw new Error(
      `No organization found for entity code ${config.entityCode}`,
    );
  }
  const principal = await resolveApplicationPrincipal(operatingPool, {
    issuer: "demandstar-bridge",
    subject: config.serviceUserEmail,
    email: config.serviceUserEmail,
  });

  const result: DemandstarSyncResult = {
    scanned: 0,
    created: 0,
    replayed: 0,
    skipped: [],
  };

  for (const raw of messages) {
    const parsedMessage = demandstarMessageSchema.safeParse(raw);
    if (!parsedMessage.success) {
      result.skipped.push({
        messageId: String((raw as { id?: unknown }).id ?? "unknown"),
        reason: "message failed validation",
      });
      continue;
    }
    const message = parsedMessage.data;
    result.scanned += 1;

    if (!message.from.toLowerCase().includes(config.senderDomain)) {
      result.skipped.push({
        messageId: message.id,
        reason: `sender is not ${config.senderDomain}`,
      });
      continue;
    }

    const bid = parseDemandstarMessage(message);
    if (!bid) {
      result.skipped.push({
        messageId: message.id,
        reason: "not a bid announcement or deadline reminder",
      });
      continue;
    }

    try {
      const response = await createManualIssue(operatingPool, {
        principal,
        input: {
          organizationId,
          title: clampText(
            `Bid ${bid.bidNumber}${bid.agency ? ` — ${bid.agency}` : ""}${
              bid.bidName ? `: ${bid.bidName}` : ""
            }`,
            3,
            200,
          ),
          description: describeBid(bid, message),
          ...(bid.dueDate ? { dueDate: bid.dueDate } : {}),
          retentionClassification: "operational",
        },
        idempotencyKey: `demandstar:${bid.bidNumber}`,
        context: {
          traceId: `demandstar-${bid.bidNumber}`,
          requestId: `demandstar-bridge-${message.id}`,
        },
      });
      if (response.duplicate) {
        result.replayed += 1;
      } else {
        result.created += 1;
      }
    } catch (error) {
      if (
        error instanceof DomainError &&
        error.code === "idempotency_key_conflict"
      ) {
        // Same bid, different message wording (announcement then reminder):
        // the bid is already in intake. That is a replay, not a failure.
        result.replayed += 1;
        continue;
      }
      result.skipped.push({
        messageId: message.id,
        reason:
          error instanceof DomainError
            ? `${error.code}: ${error.message}`
            : "intake failed",
      });
    }
  }

  return result;
}
