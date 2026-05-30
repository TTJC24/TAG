import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.ts';
import { createProcurementActionPlan, type PlannedAction, type ProcurementActionPlan } from './actionPlan.ts';
import {
  compactAcumaticaContext,
  enrichProcurementRequest,
  type ProcurementAcumaticaEnrichment,
} from './enrichment.ts';
import { getProcurementPacket } from './packets.ts';
import type { ProcurementEvidence, ProcurementStructure, StructuredLine } from './structure.ts';

export type PreparedActionStatus = 'prepared' | 'approved' | 'rejected' | 'superseded';
export type ProcurementExecutionAttemptStatus = 'dry_run_recorded' | 'blocked' | 'failed';

export interface ProcurementExecutionAttempt {
  id: string;
  requestedBy: string;
  requestedAt: string;
  status: ProcurementExecutionAttemptStatus;
  adapter: string;
  externalWritePerformed: false;
  reason: string;
  payloadSnapshot: Record<string, unknown>;
}

export interface PreparedProcurementAction {
  id: string;
  packetId: string | null;
  plannedActionId: string;
  system: PlannedAction['system'];
  label: string;
  status: PreparedActionStatus;
  requiresApproval: boolean;
  preparedBy: string;
  preparedAt: string;
  updatedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  execution: {
    canExecuteNow: false;
    reason: string;
  };
  executionAttempts: ProcurementExecutionAttempt[];
  payloadPreview: Record<string, unknown>;
  evidence: ProcurementEvidence[];
}

interface ActionStore {
  actions: PreparedProcurementAction[];
}

export async function prepareProcurementActions({
  rawText,
  packetId = null,
  preparedBy = 'inside_sales',
}: {
  rawText?: string;
  packetId?: string | null;
  preparedBy?: string;
}): Promise<{
  actionPlan: ProcurementActionPlan;
  enrichment: ProcurementAcumaticaEnrichment;
  preparedActions: PreparedProcurementAction[];
}> {
  const sourceRawText = rawText ?? (packetId ? getProcurementPacket(packetId)?.rawText : undefined);
  if (!sourceRawText?.trim()) throw new Error('rawText or packetId is required');

  const actionPlan = await createProcurementActionPlan(sourceRawText);
  const enrichment = await enrichProcurementRequest(sourceRawText, actionPlan.structure);
  const now = new Date().toISOString();
  const preparedActions = actionPlan.actions
    .filter((action) => action.status !== 'blocked')
    .map((action) => ({
      id: randomUUID(),
      packetId,
      plannedActionId: action.id,
      system: action.system,
      label: action.label,
      status: 'prepared' as const,
      requiresApproval: action.requiresApproval,
      preparedBy,
      preparedAt: now,
      updatedAt: now,
      approvedBy: null,
      approvedAt: null,
      rejectionReason: null,
      execution: {
        canExecuteNow: false as const,
        reason: action.requiresApproval
          ? 'Prepared only. Human approval is recorded here before any future write adapter can run.'
          : 'Read-only preparation. No external write is performed by this action ledger.',
      },
      executionAttempts: [],
      payloadPreview: buildPayloadPreview(action, actionPlan.structure, enrichment),
      evidence: action.evidence,
    }));

  const store = readActionStore();
  if (packetId) {
    for (const action of store.actions) {
      if (action.packetId === packetId && action.status === 'prepared') {
        action.status = 'superseded';
        action.updatedAt = now;
      }
    }
  }
  store.actions.unshift(...preparedActions);
  writeActionStore(store);
  return { actionPlan, enrichment, preparedActions };
}

export function listPreparedProcurementActions(packetId?: string): PreparedProcurementAction[] {
  const actions = readActionStore().actions;
  return packetId ? actions.filter((action) => action.packetId === packetId) : actions;
}

export function approvePreparedProcurementAction(
  id: string,
  updates: { approvedBy?: string; note?: string },
): PreparedProcurementAction | null {
  const store = readActionStore();
  const action = store.actions.find((item) => item.id === id);
  if (!action) return null;
  if (action.status !== 'prepared') {
    throw new Error(`Only prepared actions can be approved; current status is ${action.status}`);
  }
  action.status = 'approved';
  action.approvedBy = updates.approvedBy?.trim() || 'inside_sales';
  action.approvedAt = new Date().toISOString();
  action.updatedAt = action.approvedAt;
  if (updates.note?.trim()) {
    action.payloadPreview.approvalNote = updates.note.trim();
  }
  writeActionStore(store);
  return action;
}

export function rejectPreparedProcurementAction(
  id: string,
  updates: { rejectedBy?: string; reason?: string },
): PreparedProcurementAction | null {
  const store = readActionStore();
  const action = store.actions.find((item) => item.id === id);
  if (!action) return null;
  if (action.status !== 'prepared') {
    throw new Error(`Only prepared actions can be rejected; current status is ${action.status}`);
  }
  action.status = 'rejected';
  action.rejectionReason = updates.reason?.trim() || `Rejected by ${updates.rejectedBy?.trim() || 'inside_sales'}`;
  action.updatedAt = new Date().toISOString();
  writeActionStore(store);
  return action;
}

export function requestProcurementActionExecution(
  id: string,
  updates: { requestedBy?: string },
): PreparedProcurementAction | null {
  const store = readActionStore();
  const action = store.actions.find((item) => item.id === id);
  if (!action) return null;
  if (action.status !== 'approved') {
    throw new Error(`Only approved actions can request execution; current status is ${action.status}`);
  }
  action.executionAttempts ??= [];
  const attempt: ProcurementExecutionAttempt = {
    id: randomUUID(),
    requestedBy: updates.requestedBy?.trim() || 'inside_sales',
    requestedAt: new Date().toISOString(),
    status: 'dry_run_recorded',
    adapter: adapterForAction(action),
    externalWritePerformed: false,
    reason: executionBoundaryReason(action),
    payloadSnapshot: action.payloadPreview,
  };
  action.executionAttempts.unshift(attempt);
  action.updatedAt = attempt.requestedAt;
  writeActionStore(store);
  return action;
}

function buildPayloadPreview(
  action: PlannedAction,
  structure: ProcurementStructure,
  enrichment: ProcurementAcumaticaEnrichment,
): Record<string, unknown> {
  if (action.id === 'prepare-acumatica-draft') return acumaticaDraftPayload(structure, action.evidence, enrichment);
  if (action.id === 'update-crm-context') return pipedriveNotePayload(structure, action.evidence);
  if (action.id === 'notify-stakeholders') return teamsNotificationPayload(structure);
  if (action.id === 'verify-customer-context') {
    return {
      operation: 'read',
      target: 'acumatica.customer',
      query: structure.fields.customerName,
      acumaticaContext: {
        customerCandidates: compactAcumaticaContext(enrichment).customerCandidates,
        recentOrders: compactAcumaticaContext(enrichment).recentOrders,
        recentInvoices: compactAcumaticaContext(enrichment).recentInvoices,
      },
      evidenceSlugs: evidenceSlugs(action.evidence),
    };
  }
  if (action.id === 'source-requested-items') {
    return {
      operation: 'read',
      target: 'acumatica.inventory_and_vendor_history',
      lines: structure.lines.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
      })),
      acumaticaContext: {
        lineItems: compactAcumaticaContext(enrichment).lineItems,
      },
      evidenceSlugs: evidenceSlugs(action.evidence),
    };
  }
  return {
    operation: 'prepare',
    target: action.system,
    request: summarizeStructure(structure),
    evidenceSlugs: evidenceSlugs(action.evidence),
  };
}

function acumaticaDraftPayload(
  structure: ProcurementStructure,
  evidence: ProcurementEvidence[],
  enrichment: ProcurementAcumaticaEnrichment,
): Record<string, unknown> {
  return {
    operation: 'prepare_only',
    target: 'acumatica.sales_order_or_purchase_request',
    endpointVersion: config.ACUMATICA_ENDPOINT_VERSION,
    hold: true,
    customerName: structure.fields.customerName,
    shipTo: structure.fields.shipTo,
    contactName: structure.fields.contactName,
    contactEmail: structure.fields.contactEmail,
    jobName: structure.fields.jobName,
    neededBy: structure.fields.neededBy,
    deliveryMethod: structure.fields.deliveryMethod,
    taxNotes: structure.fields.taxNotes,
    lines: structure.lines.map(toPayloadLine),
    acumaticaContext: compactAcumaticaContext(enrichment),
    sourceEvidence: evidenceSlugs(evidence),
    guardrail: 'This is a payload preview only. No Acumatica write has been executed.',
  };
}

function pipedriveNotePayload(structure: ProcurementStructure, evidence: ProcurementEvidence[]): Record<string, unknown> {
  return {
    operation: 'prepare_only',
    target: 'pipedrive.organization_or_deal_note',
    matchBy: {
      organizationName: structure.fields.customerName,
      contactEmail: structure.fields.contactEmail,
    },
    note: summarizeStructure(structure),
    sourceEvidence: evidenceSlugs(evidence),
    guardrail: 'This is a payload preview only. No Pipedrive write has been executed.',
  };
}

function teamsNotificationPayload(structure: ProcurementStructure): Record<string, unknown> {
  return {
    operation: 'prepare_only',
    target: 'm365-teams.procurement_review_channel',
    message: summarizeStructure(structure),
    guardrail: 'This is a payload preview only. No Teams message has been sent.',
  };
}

function toPayloadLine(line: StructuredLine): Record<string, unknown> {
  return {
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    confidence: line.confidence,
  };
}

function summarizeStructure(structure: ProcurementStructure): string {
  const fields = structure.fields;
  const lines = structure.lines
    .map((line) => `- ${line.quantity ?? '?'} ${line.unit ?? ''} ${line.description}`.replace(/\s+/g, ' ').trim())
    .join('\n');
  return [
    `Customer: ${fields.customerName ?? 'Unknown'}`,
    `Ship to: ${fields.shipTo ?? 'Unknown'}`,
    fields.jobName ? `Job: ${fields.jobName}` : null,
    fields.neededBy ? `Needed by: ${fields.neededBy}` : null,
    lines ? `Items:\n${lines}` : 'Items: none detected',
  ].filter(Boolean).join('\n');
}

function evidenceSlugs(evidence: ProcurementEvidence[]): string[] {
  return evidence.map((item) => item.slug).filter(Boolean).slice(0, 12);
}

function readActionStore(): ActionStore {
  const path = actionStorePath();
  if (!existsSync(path)) return { actions: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ActionStore>;
  return {
    actions: Array.isArray(parsed.actions) ? parsed.actions.map(normalizeAction) : [],
  };
}

function normalizeAction(action: PreparedProcurementAction): PreparedProcurementAction {
  return {
    ...action,
    executionAttempts: Array.isArray(action.executionAttempts) ? action.executionAttempts : [],
  };
}

function writeActionStore(store: ActionStore): void {
  const path = actionStorePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(store, null, 2));
  renameSync(tmpPath, path);
}

function actionStorePath(): string {
  const procurementStorePath = config.PROCUREMENT_STORE_PATH;
  if (procurementStorePath) return resolve(dirname(resolve(procurementStorePath)), 'procurement-actions.json');
  const brainStorePath = process.env.COMPANY_BRAIN_STORE_PATH;
  if (brainStorePath) return resolve(dirname(resolve(brainStorePath)), 'procurement-actions.json');
  return resolve(process.cwd(), '.company-brain-procurement-actions.json');
}

function adapterForAction(action: PreparedProcurementAction): string {
  if (action.plannedActionId === 'prepare-acumatica-draft') return 'acumatica.draft_hold_writer';
  if (action.plannedActionId === 'update-crm-context') return 'pipedrive.note_writer';
  if (action.plannedActionId === 'notify-stakeholders') return 'm365-teams.notification_writer';
  if (action.system === 'acumatica') return 'acumatica.read_adapter';
  return `${action.system}.adapter`;
}

function executionBoundaryReason(action: PreparedProcurementAction): string {
  if (action.plannedActionId === 'prepare-acumatica-draft') {
    return 'Dry-run recorded. Acumatica draft/hold writes are not enabled until the bounded write adapter is implemented and explicitly configured.';
  }
  if (action.plannedActionId === 'update-crm-context') {
    return 'Dry-run recorded. Pipedrive writes wait for a successful approved Acumatica action and an enabled CRM adapter.';
  }
  if (action.plannedActionId === 'notify-stakeholders') {
    return 'Dry-run recorded. Teams notifications wait for a successful approved Acumatica action and an enabled notification adapter.';
  }
  return 'Dry-run recorded. This action has no external write adapter enabled.';
}
