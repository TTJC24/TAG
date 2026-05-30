import { askBrain, type BrainAnswer } from '../ask.ts';
import { createProcurementActionPlan, type ProcurementActionPlan } from '../procurement/actionPlan.ts';
import { procurementPlanBrainAnswer } from '../procurement/answer.ts';
import { prepareProcurementActions, type PreparedProcurementAction } from '../procurement/actions.ts';
import { createProcurementPacket, type ProcurementPacket } from '../procurement/packets.ts';
import type { ProcurementAcumaticaEnrichment } from '../procurement/enrichment.ts';

export interface AgentChatResponse {
  mode: 'answer' | 'procurement_plan';
  answer: BrainAnswer;
  actionPlan: ProcurementActionPlan | null;
  suggestedNextStep: string;
}

export interface AgentProcurementWorkflowResponse {
  chat: AgentChatResponse;
  packet: ProcurementPacket;
  enrichment: ProcurementAcumaticaEnrichment;
  preparedActions: PreparedProcurementAction[];
  reviewUrlHint: string;
}

const PROCUREMENT_TERMS = [
  'buy',
  'source',
  'sourcing',
  'vendor',
  'po',
  'purchase order',
  'quote',
  'order',
  'ship to',
  'needed by',
  'need by',
  'item',
  'items',
  'material',
  'materials',
  'acumatica',
  'stock',
  'inventory',
  'customer:',
  'items:',
];

export async function agentChat(message: string): Promise<AgentChatResponse> {
  const procurementIntent = isProcurementIntent(message);
  if (procurementIntent) {
    const actionPlan = await createProcurementActionPlan(message);
    return {
      mode: 'procurement_plan',
      answer: procurementPlanBrainAnswer(actionPlan),
      actionPlan,
      suggestedNextStep: nextProcurementStep(actionPlan),
    };
  }

  const answer = await askBrain({ question: message, limit: 10 });

  return {
    mode: 'answer',
    answer,
    actionPlan: null,
    suggestedNextStep: 'Ask a follow-up or include customer, item, order, vendor, or shipment details for an action plan.',
  };
}

export async function createAgentProcurementWorkflow({
  message,
  submittedBy = 'inside_sales',
}: {
  message: string;
  submittedBy?: string;
}): Promise<AgentProcurementWorkflowResponse> {
  const chat = await agentChat(message);
  if (chat.mode !== 'procurement_plan' || !chat.actionPlan) {
    throw new Error('Message does not look like a procurement request.');
  }
  const packet = await createProcurementPacket({
    rawText: message,
    submittedBy,
  });
  const prepared = await prepareProcurementActions({
    packetId: packet.id,
    preparedBy: submittedBy,
  });
  return {
    chat,
    packet,
    enrichment: prepared.enrichment,
    preparedActions: prepared.preparedActions,
    reviewUrlHint: `procurement:${packet.id}`,
  };
}

function isProcurementIntent(message: string): boolean {
  const normalized = message.toLowerCase();
  const matchedTerms = PROCUREMENT_TERMS.filter((term) => normalized.includes(term)).length;
  if (matchedTerms >= 2) return true;
  if (/^\s*(customer|ship to|items?)\s*:/im.test(message)) return true;
  if (/\b(need|needs|quote|order)\b.+\b(ea|box|boxes|pcs|ft|lf|sf)\b/i.test(message)) return true;
  return false;
}

function nextProcurementStep(plan: ProcurementActionPlan): string {
  if (plan.blockers.length > 0) {
    return `Resolve ${plan.blockers.length} blocker(s), then regenerate the action plan.`;
  }
  if (plan.actions.some((action) => action.status === 'needs_approval')) {
    return 'Review and approve the proposed Acumatica/CRM/stakeholder actions before any write adapter runs.';
  }
  return 'Review the source evidence and prepare the next approved action.';
}
