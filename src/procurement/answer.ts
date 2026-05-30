import type { BrainAnswer, BrainCitation } from '../ask.ts';
import type { ProcurementActionPlan } from './actionPlan.ts';

export function procurementPlanBrainAnswer(plan: ProcurementActionPlan): BrainAnswer {
  const { fields, lines } = plan.structure;
  const canonicalCustomer = canonicalCustomerName(plan) ?? fields.customerName;
  const answerLines = [
    'I structured this as a procurement request and prepared a review-only action plan.',
    `Customer: ${canonicalCustomer ?? 'Missing'}`,
    `Ship to: ${fields.shipTo ?? 'Missing'}`,
    `Lines: ${lines.length ? lines.map(formatLine).join('; ') : 'Missing'}`,
  ];
  if (plan.blockers.length > 0) {
    answerLines.push(`Blockers: ${plan.blockers.slice(0, 3).join('; ')}`);
  }
  answerLines.push('No external system writes will run without approval.');

  return {
    text: answerLines.join('\n'),
    citations: procurementCitations(plan),
    memories: [],
    intent: 'procurement_request',
    scope: 'procurement',
    confidence: plan.structure.confidence >= 70 ? 'high' : plan.structure.confidence >= 45 ? 'medium' : 'low',
    resolvedEntity: canonicalCustomer
      ? {
          query: fields.customerName ?? canonicalCustomer,
          canonicalName: canonicalCustomer,
          aliases: Array.from(new Set([fields.customerName, canonicalCustomer].filter(Boolean) as string[])),
          sourceIds: ['acumatica', 'pipedrive'],
          confidence: fields.customerName === canonicalCustomer ? 'medium' : 'high',
          alternatives: [],
          ambiguous: false,
        }
      : null,
  };
}

function procurementCitations(plan: ProcurementActionPlan): BrainCitation[] {
  const seen = new Set<string>();
  const evidence = [
    ...plan.structure.evidence.customer,
    ...plan.structure.evidence.lines.flatMap((entry) => entry.hits),
  ];
  const systemOfRecordEvidence = evidence.filter((item) => {
    const sourceId = item.source_id ?? '';
    return sourceId === 'acumatica' || sourceId === 'pipedrive';
  });
  const citations: BrainCitation[] = [];
  for (const item of systemOfRecordEvidence.length ? systemOfRecordEvidence : evidence) {
    if (seen.has(item.slug)) continue;
    seen.add(item.slug);
    citations.push({
      slug: item.slug,
      source_id: item.source_id ?? 'unknown',
      title: item.title,
      source_uri: item.source_uri,
    });
    if (citations.length >= 3) break;
  }
  return citations;
}

function canonicalCustomerName(plan: ProcurementActionPlan): string | null {
  return plan.structure.evidence.customer.find((item) => item.title)?.title ?? null;
}

function formatLine(line: ProcurementActionPlan['structure']['lines'][number]): string {
  return [line.quantity, line.unit, line.description].filter(Boolean).join(' ');
}
