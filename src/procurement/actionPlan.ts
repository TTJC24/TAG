import {
  structureProcurementRequest,
  type ProcurementEvidence,
  type ProcurementStructure,
} from './structure.ts';

export type PlannedActionSystem = 'acumatica' | 'pipedrive' | 'm365-teams' | 'm365-mail' | 'company-brain';

export interface PlannedAction {
  id: string;
  system: PlannedActionSystem;
  label: string;
  status: 'blocked' | 'needs_approval' | 'ready_to_prepare';
  reason: string;
  requiresApproval: boolean;
  evidence: ProcurementEvidence[];
}

export interface ProcurementActionPlan {
  structure: ProcurementStructure;
  blockers: string[];
  actions: PlannedAction[];
  executionPolicy: {
    canExecuteNow: false;
    reason: string;
  };
}

export async function createProcurementActionPlan(rawText: string): Promise<ProcurementActionPlan> {
  const structure = await structureProcurementRequest(rawText);
  const blockers = [
    ...structure.warnings,
    ...missingExecutionInputs(structure),
  ];
  const customerEvidence = structure.evidence.customer.slice(0, 3);
  const lineEvidence = structure.evidence.lines.flatMap((line) => line.hits.slice(0, 2));
  const hasLineEvidence = structure.evidence.lines.every((line) => line.hits.length > 0);

  const actions: PlannedAction[] = [
    {
      id: 'verify-customer-context',
      system: 'acumatica',
      label: 'Verify customer, ship-to, tax, and account context',
      status: structure.fields.customerName && customerEvidence.length > 0 ? 'ready_to_prepare' : 'blocked',
      reason: customerEvidence.length > 0
        ? 'Customer evidence is available from indexed Acumatica/Pipedrive context.'
        : 'Customer could not be matched to indexed account evidence.',
      requiresApproval: false,
      evidence: customerEvidence,
    },
    {
      id: 'source-requested-items',
      system: 'acumatica',
      label: 'Find item, inventory, vendor, and recent purchase history for requested lines',
      status: structure.lines.length > 0 && hasLineEvidence ? 'ready_to_prepare' : 'blocked',
      reason: hasLineEvidence
        ? 'Each parsed line has at least one indexed candidate source.'
        : 'One or more requested lines lack source-backed item or history candidates.',
      requiresApproval: false,
      evidence: lineEvidence,
    },
    {
      id: 'prepare-acumatica-draft',
      system: 'acumatica',
      label: 'Prepare Acumatica draft or hold-status action',
      status: blockers.length === 0 ? 'needs_approval' : 'blocked',
      reason: blockers.length === 0
        ? 'The request has enough structure to prepare a non-executing draft after human approval.'
        : 'Missing or ambiguous request details must be resolved before drafting.',
      requiresApproval: true,
      evidence: [...customerEvidence, ...lineEvidence].slice(0, 5),
    },
    {
      id: 'update-crm-context',
      system: 'pipedrive',
      label: 'Attach request summary and sourcing state to CRM/customer context',
      status: structure.fields.customerName ? 'needs_approval' : 'blocked',
      reason: structure.fields.customerName
        ? 'A customer name is available for CRM context matching.'
        : 'CRM update needs a customer or organization match.',
      requiresApproval: true,
      evidence: customerEvidence,
    },
    {
      id: 'notify-stakeholders',
      system: 'm365-teams',
      label: 'Notify inside sales/purchasing stakeholders with review packet',
      status: blockers.length === 0 ? 'needs_approval' : 'blocked',
      reason: blockers.length === 0
        ? 'A structured packet can be summarized for internal review.'
        : 'Stakeholder update should wait until missing fields are resolved.',
      requiresApproval: true,
      evidence: [],
    },
  ];

  return {
    structure,
    blockers,
    actions,
    executionPolicy: {
      canExecuteNow: false,
      reason: 'Company Brain is in planning and review mode. External system writes require explicit approval and dedicated write adapters.',
    },
  };
}

function missingExecutionInputs(structure: ProcurementStructure): string[] {
  const missing: string[] = [];
  if (!structure.fields.customerName) missing.push('Customer is required before any Acumatica or CRM action.');
  if (!structure.fields.shipTo) missing.push('Ship-to is required before sourcing or draft fulfillment action.');
  if (!structure.lines.length) missing.push('At least one requested line item is required.');
  for (const line of structure.lines) {
    if (!line.quantity) missing.push(`Quantity is required for ${line.description}.`);
  }
  return [...new Set(missing)];
}
