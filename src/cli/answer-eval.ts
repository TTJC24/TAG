#!/usr/bin/env node
import { existsSync, unlinkSync } from 'node:fs';
import { agentChat } from '../agent/chat.ts';
import { askBrain, type BrainAnswer } from '../ask.ts';
import type { PlannedAction } from '../procurement/actionPlan.ts';
import { runIngestion } from '../ingest/run.ts';
import { connectors } from '../sources/registry.ts';
import { openEngine } from '../engine.ts';

type AskExpectation = {
  name: string;
  question: string;
  assert: (answer: BrainAnswer) => void;
  skip?: true;
  reason?: string;
};

type EvalResult =
  | { name: string; ok: true }
  | { name: string; skipped: true; reason: string };

async function ensureFixtureBrain(): Promise<void> {
  if (existsSync('.company-brain-store.json')) {
    unlinkSync('.company-brain-store.json');
  }

  const engine = await openEngine();
  try {
    const stats = await engine.getStats() as { page_count?: number };
    if (Number(stats.page_count ?? 0) > 0) return;
  } finally {
    await engine.disconnect();
  }

  for (const spec of Object.values(connectors)) {
    const source = await spec.build({ dryRun: true });
    await runIngestion(spec.id, spec.displayName, source, {
      dryRun: false,
      noEmbed: true,
      ingestedVia: 'answer-eval-fixtures',
      summaryOnly: true,
      quiet: true,
    });
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function assertCleanAnswer(answer: BrainAnswer): void {
  assert(!/\bFound\s+\d+\s+chunk/i.test(answer.text), 'exposed raw chunk count');
  assert(!answer.text.includes('## Fields'), 'exposed indexed field heading');
  assert(!answer.text.includes('**'), 'exposed markdown field markup');
  assert(!answer.text.includes('{"id"'), 'exposed raw JSON object');
  assert(!/\[object Object\]/i.test(answer.text), 'exposed JavaScript object placeholder');
}

function assertText(answer: BrainAnswer, pattern: RegExp, message: string): void {
  assert(pattern.test(answer.text), `${message}\nAnswer:\n${answer.text}`);
}

function assertNotText(answer: BrainAnswer, pattern: RegExp, message: string): void {
  assert(!pattern.test(answer.text), `${message}\nAnswer:\n${answer.text}`);
}

function assertNoCitation(answer: BrainAnswer, pattern: RegExp, message: string): void {
  const leaked = answer.citations.find((citation) => pattern.test(`${citation.title ?? ''} ${citation.slug}`));
  assert(!leaked, `${message}\nCitation: ${leaked?.title ?? leaked?.slug}`);
}

const askCases: AskExpectation[] = [
  {
    name: 'customer shorthand resolves terms directly',
    question: 'terms for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assert(answer.confidence !== 'low', `expected medium/high confidence, got ${answer.confidence}`);
      assert(answer.resolvedEntity?.canonicalName === 'ACME Barricades LC', 'did not resolve ACME canonical entity');
      assertText(answer, /ACME Barricades LC/i, 'answer did not name the resolved customer');
      assertText(answer, /\bTerms:\s*N30\b/i, 'answer did not lead with terms');
      assertNotText(answer, /Bob'?s Barricades/i, 'answer leaked unrelated barricades account');
    },
  },
  {
    name: 'owner ask resolves person cleanly',
    question: 'who owns acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'contact_lookup', `expected contact_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assert(answer.resolvedEntity?.canonicalName === 'ACME Barricades LC', 'did not keep owner ask on ACME');
      assertText(answer, /\bOwner:\s*Tim Clark\b/i, 'answer did not resolve owner name');
      assertNotText(answer, /Owner ID:\s*\{/i, 'answer exposed unresolved owner object');
    },
  },
  {
    name: 'weak item match is refused',
    question: 'price for pump a14',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'item_lookup', `expected item_lookup, got ${answer.intent}`);
      assert(answer.scope === 'procurement', `expected procurement scope, got ${answer.scope}`);
      assert(answer.confidence === 'low', `expected low confidence, got ${answer.confidence}`);
      assertText(answer, /could not find a solid item match/i, 'weak item match was not refused');
      assertNotText(answer, /\b(Default price|List price|Amount|Order total):/i, 'weak item ask returned unrelated pricing');
    },
  },
  {
    name: 'exact SKU price returns item pricing',
    question: 'price for 00286',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'item_lookup', `expected item_lookup, got ${answer.intent}`);
      assert(answer.scope === 'procurement', `expected procurement scope, got ${answer.scope}`);
      assertText(answer, /Inventory ID:\s*00286/i, 'exact SKU price did not return requested item');
      assertText(answer, /(Current price|Default price):\s*25\.1/i, 'exact SKU price did not render indexed item price');
      assertNotText(answer, /customer-specific contract/i, 'generic SKU price should not show customer-specific pricing caveat');
    },
  },
  {
    name: 'customer-specific item price gets base price caveat',
    question: 'what price does acme get on wedge anchors',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'item_lookup', `expected item_lookup, got ${answer.intent}`);
      assert(answer.scope === 'procurement', `expected procurement scope, got ${answer.scope}`);
      assertText(answer, /Current price:\s*25\.1|Default price:\s*25\.1/i, 'customer-specific item price ask did not return base item price');
      assertText(answer, /did not find customer-specific contract or special pricing/i, 'customer-specific item price ask did not flag missing customer-specific price');
      assertNotText(answer, /ACME Barricades LC:\s*Terms|Credit limit/i, 'customer-specific item price ask borrowed customer account fields');
    },
  },
  {
    name: 'contract price ask gets missing contract pricing caveat',
    question: 'contract price for acme wedge anchors',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'item_lookup', `expected item_lookup, got ${answer.intent}`);
      assert(answer.scope === 'procurement', `expected procurement scope, got ${answer.scope}`);
      assertText(answer, /Current price:\s*25\.1|Default price:\s*25\.1/i, 'contract price ask did not return base item price');
      assertText(answer, /did not find customer-specific contract or special pricing/i, 'contract price ask did not flag missing contract price');
    },
  },
  {
    name: 'unknown order does not hallucinate a status',
    question: 'status of so-100231',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'order_lookup', `expected order_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      if (answer.confidence === 'low') {
        assertText(answer, /could not find a solid order match/i, 'low-confidence order ask should explain no match');
      } else {
        assertText(answer, /\bSO-?100231\b/i, 'order answer did not match requested order number');
        assertNotText(answer, /Also possibly relevant:/i, 'direct order answer should not spray alternates');
      }
    },
  },
  {
    name: 'unknown invoice id does not expose object alternatives',
    question: 'invoice amount inv-12345',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'invoice_lookup', `expected invoice_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertNotText(answer, /\[object Object\]|\{"id"/i, 'invoice miss exposed object-like alternatives');
      if (answer.confidence === 'low') {
        assertText(answer, /could not find a solid invoice match|ambiguous/i, 'low-confidence invoice ask should refuse or clarify');
      } else {
        assertText(answer, /\binv-?12345\b/i, 'invoice answer did not match requested invoice id');
      }
    },
  },
  {
    name: 'order ask for customer does not fall back to customer status',
    question: 'open orders for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'order_lookup', `expected order_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertNotText(answer, /ACME Barricades LC:\s*Status:\s*Active/i, 'order ask fell back to customer status');
      if (answer.confidence === 'low') {
        assertText(answer, /could not find a solid order match/i, 'missing customer order ask should refuse cleanly');
      }
    },
  },
  {
    name: 'tracking ask does not fall back to customer status',
    question: 'tracking for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'order_lookup', `expected order_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertNotText(answer, /ACME Barricades LC:\s*Status:\s*Active|Terms:/i, 'tracking ask fell back to customer status');
      assertText(answer, /Delivery and tracking data \(TrackPod\) is not yet connected to the brain/i, 'tracking ask did not show TrackPod caveat');
      if (answer.confidence === 'low') {
        assertText(answer, /could not find a solid order match/i, 'missing tracking ask should refuse cleanly');
      }
    },
  },
  {
    name: 'backorder ask does not fall back to customer status',
    question: 'backorder for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'order_lookup', `expected order_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertNotText(answer, /ACME Barricades LC:\s*Status:\s*Active|Terms:/i, 'backorder ask fell back to customer status');
      if (answer.confidence === 'low') {
        assertText(answer, /could not find a solid order match/i, 'missing backorder ask should refuse cleanly');
      }
    },
  },
  {
    name: 'SO shorthand routes to order lookup',
    question: 'open so for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'order_lookup', `expected order_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertNotText(answer, /ACME Barricades LC:\s*Status:\s*Active|Terms:/i, 'SO shorthand fell back to customer status');
      assertNotText(answer, /TrackPod/i, 'generic SO shorthand should not show TrackPod caveat');
      if (answer.confidence === 'low') {
        assertText(answer, /could not find a solid order match/i, 'missing SO shorthand ask should refuse cleanly');
      }
    },
  },
  {
    name: 'quote lookup stays read-only and does not create procurement plan',
    question: 'open quote for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'order_lookup', `expected order_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertNotText(answer, /structured this as a procurement request|No external system writes/i, 'quote lookup was misrouted to procurement planning');
      if (answer.confidence === 'low') {
        assertText(answer, /could not find a solid quote\/order match/i, 'missing quote ask should refuse as quote/order lookup');
      }
    },
  },
  {
    name: 'proof of delivery ask shows TrackPod caveat',
    question: 'proof of delivery for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'order_lookup', `expected order_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertText(answer, /Delivery and tracking data \(TrackPod\) is not yet connected to the brain/i, 'POD ask did not show TrackPod caveat');
      assertNotText(answer, /ACME Barricades LC:\s*Status:\s*Active|Terms:/i, 'POD ask fell back to customer status');
    },
  },
  {
    name: 'route ask shows TrackPod caveat',
    question: 'route for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'order_lookup', `expected order_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertText(answer, /Delivery and tracking data \(TrackPod\) is not yet connected to the brain/i, 'route ask did not show TrackPod caveat');
      assertNotText(answer, /ACME Barricades LC:\s*Status:\s*Active|Terms:/i, 'route ask fell back to customer status');
    },
  },
  {
    name: 'mixed shipment and meeting ask preserves both lanes',
    question: "did we ship the wedge anchors to acme and when's the next meeting",
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'mixed_intent', `expected mixed_intent, got ${answer.intent}`);
      assert(answer.scope === 'all', `expected all scope for order + collaboration mix, got ${answer.scope}`);
      assertText(answer, /^Order:/im, 'mixed shipment/meeting ask did not render order section');
      assertText(answer, /^Collaboration record:/im, 'mixed shipment/meeting ask did not render collaboration section');
      assertText(answer, /\bStart:\s*2026-06-01T/i, 'mixed shipment/meeting ask did not answer next meeting lane');
      assertNotText(answer, /ACME Barricades LC:\s*Status:\s*Active|Terms:\s*N30/i, 'mixed shipment/meeting ask leaked customer account summary into shipment lane');
    },
  },
  {
    name: 'invoice ask for customer does not fall back to customer record',
    question: 'recent invoices for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'invoice_lookup', `expected invoice_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertNotText(answer, /Best match:\s*ACME Barricades LC|Customer ID:|Terms:/i, 'invoice ask fell back to customer record');
      if (answer.confidence === 'low') {
        assertText(answer, /could not find a solid invoice match/i, 'missing customer invoice ask should refuse cleanly');
      }
    },
  },
  {
    name: 'owe phrasing is AR invoice lookup not customer summary',
    question: 'does acme owe us anything',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'invoice_lookup', `expected invoice_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertNotText(answer, /Best match:\s*ACME Barricades LC|Customer ID:|Terms:|Status:\s*Active/i, 'owe/AR ask fell back to customer master data');
      if (answer.confidence === 'low') {
        assertText(answer, /could not find a solid invoice match/i, 'missing AR ask should refuse cleanly');
      }
    },
  },
  {
    name: 'balance phrasing is invoice lookup not account status',
    question: 'balance for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'invoice_lookup', `expected invoice_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertNotText(answer, /Best match:\s*ACME Barricades LC|Terms:|Status:\s*Active/i, 'balance ask fell back to customer status');
      if (answer.confidence === 'low') {
        assertText(answer, /could not find a solid invoice match/i, 'missing balance ask should refuse cleanly');
      }
    },
  },
  {
    name: 'payment history ask does not fall back to customer summary',
    question: 'last payment from acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'invoice_lookup', `expected invoice_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertNotText(answer, /Best match:\s*ACME Barricades LC|Customer ID:|Terms:|Status:\s*Active/i, 'payment history ask fell back to customer master data');
      if (answer.confidence === 'low') {
        assertText(answer, /could not find a solid payment\/invoice match/i, 'missing payment history ask should refuse as payment/invoice lookup');
      }
    },
  },
  {
    name: 'broad AR ask routes to invoices not contact/customer noise',
    question: 'who owes us money',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'invoice_lookup', `expected invoice_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertNotText(answer, /Owner:|Owner ID:|Terms:|Customer ID:\s*ACME|Status:\s*Active/i, 'broad AR ask fell back to contact or customer master data');
      if (answer.citations.length > 0) {
        assert(answer.citations.every((citation) => citation.source_id === 'acumatica'), 'broad AR ask should cite only Acumatica invoices');
        assertText(answer, /Reference number:|Balance:|Amount:/i, 'broad AR ask with citations should render invoice fields');
      } else {
        assertText(answer, /could not find a solid invoice match/i, 'broad AR ask should refuse as invoice lookup when no invoice evidence exists');
      }
    },
  },
  {
    name: 'credit hold ask does not answer credit limit',
    question: 'credit hold for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertText(answer, /ACME Barricades LC/i, 'credit hold ask did not resolve ACME');
      assertText(answer, /Status:\s*Active/i, 'credit hold ask did not return account status context');
      assertNotText(answer, /Credit limit:\s*20000/i, 'credit hold ask answered credit limit instead of hold/status context');
    },
  },
  {
    name: 'terms plus credit hold status stays on customer account fields',
    question: "what's acme's terms and credit hold status",
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertText(answer, /\bTerms:\s*N30\b/i, 'terms + credit hold ask did not answer terms');
      assertText(answer, /Status:\s*Active/i, 'terms + credit hold ask did not return status context');
      assertNotText(answer, /could not find a solid order match|Order number:/i, 'terms + credit hold ask was stolen by order status');
    },
  },
  {
    name: 'specific customer does not leak alternates',
    question: 'terms for ACME Barricades',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.confidence !== 'low', `expected medium/high confidence, got ${answer.confidence}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertText(answer, /\bTerms:\s*N30\b/i, 'specific customer terms were not answered');
      assertNotText(answer, /Also possibly relevant:/i, 'specific high-confidence ask leaked alternate records');
      assertNotText(answer, /Bob'?s Barricades/i, 'specific high-confidence ask leaked unrelated account');
    },
  },
  {
    name: 'customer field ask ignores unrelated item words',
    question: 'terms for acme wedge anchors',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertText(answer, /ACME Barricades LC/i, 'mixed customer/item terms ask did not resolve ACME');
      assertText(answer, /\bTerms:\s*N30\b/i, 'mixed customer/item terms ask did not answer terms');
      assertNotText(answer, /TIEMAX|Inventory ID|#\s*Fields/i, 'mixed customer/item terms ask leaked item or metadata context');
      assert(answer.citations.every((citation) => ['acumatica', 'pipedrive'].includes(citation.source_id)), 'mixed terms ask should cite only revenue sources');
    },
  },
  {
    name: 'noisy sales phrasing resolves customer terms',
    question: 'can we sell acme wedge anchors and what are their terms',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertText(answer, /ACME Barricades LC/i, 'noisy sales phrasing did not resolve ACME');
      assertText(answer, /\bTerms:\s*N30\b/i, 'noisy sales phrasing did not answer terms');
      assertNotText(answer, /Able Trim and Door|TIEMAX|Inventory ID/i, 'noisy sales phrasing was pulled to a glue-word or item match');
    },
  },
  {
    name: 'rep ask wins over incidental invoice wording',
    question: 'who is the rep for acme and any open invoice',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'contact_lookup', `expected contact_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertText(answer, /Owner:\s*Tim Clark/i, 'rep ask with incidental invoice wording did not answer owner');
      assertNotText(answer, /could not find a solid invoice match/i, 'incidental invoice wording stole the contact intent');
    },
  },
  {
    name: 'mixed AR and owner ask answers both lanes separately',
    question: 'how much does acme owe and who owns it',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'mixed_intent', `expected mixed_intent, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops' || answer.scope === 'all', `expected revenue/all scope, got ${answer.scope}`);
      assertText(answer, /^Invoice:/im, 'mixed AR/contact ask did not render invoice section');
      assertText(answer, /^Contact:/im, 'mixed AR/contact ask did not render contact section');
      assertText(answer, /Owner:\s*Tim Clark/i, 'mixed AR/contact ask did not answer owner lane');
      assertNotText(answer, /Also possibly relevant:/i, 'mixed AR/contact ask leaked alternate chunks');
    },
  },
  {
    name: 'singular email for customer is contact lookup',
    question: 'email for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'contact_lookup', `expected contact_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertText(answer, /ACME Barricades LC/i, 'customer email ask did not resolve ACME');
      assertNotText(answer, /collaboration record match/i, 'customer email ask was misrouted to mailbox search');
      assert(answer.citations.every((citation) => ['acumatica', 'pipedrive'].includes(citation.source_id)), 'customer email ask should stay on revenue sources');
    },
  },
  {
    name: 'terse customer email shorthand is contact lookup',
    question: 'acme email',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'contact_lookup', `expected contact_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertText(answer, /ACME Barricades LC/i, 'terse customer email ask did not resolve ACME');
      assertNotText(answer, /collaboration record match/i, 'terse customer email ask was misrouted to mailbox search');
    },
  },
  {
    name: 'temporal email about customer stays mailbox lookup',
    question: 'latest acme email',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'collaboration_lookup', `expected collaboration_lookup, got ${answer.intent}`);
      assert(answer.scope === 'collaboration', `expected collaboration scope, got ${answer.scope}`);
      assertText(answer, /could not find a solid collaboration record match|Received:/i, 'temporal email ask should search mailbox context');
      assertNotText(answer, /Contact email|Customer ID:|Terms:/i, 'temporal email ask borrowed customer fields');
    },
  },
  {
    name: 'latest call ask returns sales activity not customer terms',
    question: 'latest call with acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'collaboration_lookup', `expected collaboration_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertText(answer, /sales activity|Subject:|Type:\s*call/i, 'latest call ask should stay in sales activity context');
      assertNotText(answer, /Terms:|Credit limit:|Customer ID:/i, 'latest call ask borrowed customer master data');
      assert(answer.citations.every((citation) => ['pipedrive', 'm365-mail', 'm365-teams', 'm365-calendar'].includes(citation.source_id)), 'latest call should cite activity/collaboration context only');
    },
  },
  {
    name: 'deal ask stays in pipeline and does not answer customer terms',
    question: 'open deals for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'pipeline_lookup', `expected pipeline_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertNotText(answer, /Terms:|Credit limit:|Customer ID:|ACME Barricades LC:\s*Status:\s*Active/i, 'deal ask fell back to customer master data');
      assert(answer.citations.every((citation) => citation.source_id === 'pipedrive'), 'deal ask should cite only Pipedrive pipeline evidence');
    },
  },
  {
    name: 'phone ask does not answer with generic account summary when phone is missing',
    question: 'phone number for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'contact_lookup', `expected contact_lookup, got ${answer.intent}`);
      assertText(answer, /did not find the requested field/i, 'missing phone ask should say the phone field is absent');
      assertNotText(answer, /Terms:|Status:\s*Active|Customer ID:/i, 'missing phone ask leaked unrelated account fields');
    },
  },
  {
    name: 'general customer ask stays on resolved entity',
    question: 'what do we know about acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assert(answer.resolvedEntity?.canonicalName === 'ACME Barricades LC', 'general ACME ask did not resolve customer');
      assertText(answer, /ACME Barricades LC/i, 'general ACME ask did not answer about ACME');
      assertNotText(answer, /Also possibly relevant:/i, 'general resolved customer ask leaked alternates');
      assertNotText(answer, /Share drive|Rig Roofing|Sanford Hardware/i, 'general resolved customer ask leaked unrelated records');
      assertNoCitation(answer, /Share drive|Rig Roofing|Sanford Hardware/i, 'general resolved customer ask leaked unrelated citation');
    },
  },
  {
    name: 'customer credit ask keeps citations on entity',
    question: 'credit limit for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertText(answer, /\bCredit limit:\s*20000\b/i, 'credit limit was not answered');
      assertNoCitation(answer, /Sanford Hardware|Share drive|Rig Roofing/i, 'credit ask leaked unrelated citation');
      assert(
        answer.citations.every((citation) => ['acumatica', 'pipedrive'].includes(citation.source_id)),
        'credit ask should stay inside revenue system-of-record sources',
      );
    },
  },
  {
    name: 'price class ask routes to customer pricing fields',
    question: 'price class for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertText(answer, /Customer class:\s*CIVIL/i, 'price class ask did not return customer class');
      assertText(answer, /Customer category:\s*I/i, 'price class ask did not return customer category');
      assertNotText(answer, /could not find a solid item match|Inventory ID:/i, 'price class ask was misrouted to item lookup');
    },
  },
  {
    name: 'pricing tier ask resolves customer not tier-named account',
    question: 'pricing tier for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assert(answer.resolvedEntity?.canonicalName === 'ACME Barricades LC', 'pricing tier ask did not resolve ACME');
      assertText(answer, /ACME Barricades LC/i, 'pricing tier ask did not answer for ACME');
      assertText(answer, /Customer class:\s*CIVIL/i, 'pricing tier ask did not return customer class');
      assertText(answer, /Customer category:\s*I/i, 'pricing tier ask did not return customer category');
      assertNotText(answer, /Top Tier Erosion Control/i, 'pricing tier ask matched a tier-named unrelated account');
    },
  },
  {
    name: 'entity-scoped terms ask keeps entity phrase out of customer identity',
    question: 'terms for acme at fastening specialists',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assert(answer.resolvedEntity?.canonicalName === 'ACME Barricades LC', 'entity-scoped terms ask did not resolve ACME');
      assertText(answer, /ACME Barricades LC/i, 'entity-scoped terms ask did not answer for ACME');
      assertText(answer, /\bTerms:\s*N30\b/i, 'entity-scoped terms ask did not answer terms');
      assertNotText(answer, /Fastening Specialists:\s*Terms|Ced Consolidated Electrical/i, 'entity-scoped terms ask treated entity phrase as customer identity');
    },
  },
  {
    name: 'entity-scoped price class ask keeps entity phrase out of customer identity',
    question: 'price class for acme at big league',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assert(answer.resolvedEntity?.canonicalName === 'ACME Barricades LC', 'entity-scoped price class ask did not resolve ACME');
      assertText(answer, /Customer class:\s*CIVIL/i, 'entity-scoped price class ask did not return ACME customer class');
      assertText(answer, /Customer category:\s*I/i, 'entity-scoped price class ask did not return ACME customer category');
      assertNotText(answer, /Big League Construction Supply:\s*Customer class/i, 'entity-scoped price class ask treated entity phrase as customer identity');
    },
  },
  {
    name: 'TODO(session-a): price class with FS entity uses branch-scoped class',
    question: 'price class for ACME',
    skip: true,
    reason: 'TODO(session-a): requires buildRetrievalProfile + entity-aware ingestion; entity=FS should return FS price class',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertText(answer, /Price class|Customer class/i, 'FS-scoped price class ask did not return customer pricing fields');
      assertNotText(answer, /branch context is needed/i, 'explicit FS entity should not ask for branch context');
    },
  },
  {
    name: 'TODO(session-a): price class without entity asks for branch context',
    question: 'price class for ACME',
    skip: true,
    reason: 'TODO(session-a): requires buildRetrievalProfile + entity-aware ingestion; no entity should warn that branch context is needed for accurate pricing',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertText(answer, /branch context is needed|which branch/i, 'unscoped price class ask did not request branch context');
    },
  },
  {
    name: 'warehouse SKU ask stays on item and does not borrow customer records',
    question: 'warehouse for 00286',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'item_lookup', `expected item_lookup, got ${answer.intent}`);
      assert(answer.scope === 'procurement', `expected procurement scope, got ${answer.scope}`);
      assertText(answer, /Inventory ID:\s*00286/i, 'warehouse SKU ask did not stay on requested item');
      assertText(answer, /did not find the requested field/i, 'warehouse SKU ask did not explain missing warehouse evidence');
      assertNotText(answer, /Toole's South Lake Ace Hardware|Customer ID:|Order number:|Also possibly relevant:.*\[object Object\]/i, 'warehouse SKU ask leaked customer/order noise');
      assert(answer.citations.every((citation) => citation.source_id === 'acumatica'), 'warehouse SKU ask should cite only item system-of-record records');
    },
  },
  {
    name: 'available quantity SKU ask stays on item and notes missing inventory evidence',
    question: 'available quantity for 00286',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'item_lookup', `expected item_lookup, got ${answer.intent}`);
      assert(answer.scope === 'procurement', `expected procurement scope, got ${answer.scope}`);
      assertText(answer, /Inventory ID:\s*00286/i, 'available quantity SKU ask did not stay on requested item');
      assertText(answer, /did not find the requested field/i, 'available quantity SKU ask did not explain missing availability evidence');
      assertNotText(answer, /could not find a solid item match|Customer ID:|Order number:|Toole's South Lake Ace Hardware/i, 'available quantity ask refused exact SKU or leaked unrelated records');
    },
  },
  {
    name: 'leading entity-scoped availability ask keeps entity phrase out of item identity',
    question: 'waterworks available quantity for 00286',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'item_lookup', `expected item_lookup, got ${answer.intent}`);
      assert(answer.scope === 'procurement', `expected procurement scope, got ${answer.scope}`);
      assertText(answer, /Inventory ID:\s*00286/i, 'leading entity-scoped availability ask did not stay on requested item');
      assertText(answer, /did not find the requested field/i, 'leading entity-scoped availability ask did not explain missing availability evidence');
      assertNotText(answer, /could not find a solid item match|Customer ID:|Order number:|Waterworks/i, 'leading entity-scoped availability ask treated entity phrase as item identity or leaked unrelated records');
    },
  },
  {
    name: 'branch customer ask notes missing branch field without generic leakage',
    question: 'branch for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assert(answer.resolvedEntity?.canonicalName === 'ACME Barricades LC', 'branch ask did not resolve ACME');
      assertText(answer, /ACME Barricades LC/i, 'branch ask did not answer for ACME');
      assertText(answer, /did not find the requested field/i, 'branch ask did not explain missing branch evidence');
      assertNotText(answer, /Top Tier Erosion Control|Also possibly relevant:|Share drive/i, 'branch ask leaked unrelated records');
    },
  },
  {
    name: 'credit memo ask does not answer credit limit',
    question: 'credit memo for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'credit_lookup', `expected credit_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertNotText(answer, /Credit limit:\s*20000|Terms:|Status:\s*Active/i, 'credit memo ask fell back to customer credit/account data');
      if (answer.confidence === 'low') {
        assertText(answer, /could not find a solid credit\/return match/i, 'missing credit memo ask should refuse cleanly');
      }
    },
  },
  {
    name: 'generic customer credit ask means credit memo not credit limit',
    question: 'does acme have a credit',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'credit_lookup', `expected credit_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertNotText(answer, /Credit limit:\s*20000|Terms:|Status:\s*Active/i, 'customer credit transaction ask fell back to credit limit/account data');
      if (answer.confidence === 'low') {
        assertText(answer, /could not find a solid credit\/return match/i, 'missing customer credit ask should refuse cleanly');
      }
    },
  },
  {
    name: 'RMA ask does not fall back to customer status',
    question: 'rma for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'credit_lookup', `expected credit_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertNotText(answer, /ACME Barricades LC:\s*Status:\s*Active|Terms:|Credit limit:/i, 'RMA ask fell back to customer account data');
      if (answer.confidence === 'low') {
        assertText(answer, /could not find a solid credit\/return match/i, 'missing RMA ask should refuse cleanly');
      }
    },
  },
  {
    name: 'taxable ask returns tax context not generic account summary',
    question: 'is acme taxable',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertText(answer, /Tax zone:\s*JACKSON/i, 'taxable ask did not return indexed tax zone');
      assertNotText(answer, /^Best match:/i, 'taxable ask returned a generic best-match summary');
      assert(answer.citations.every((citation) => ['acumatica', 'pipedrive'].includes(citation.source_id)), 'taxable ask should stay on revenue sources');
    },
  },
  {
    name: 'resale certificate ask notes missing certificate field',
    question: 'resale certificate for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertText(answer, /Tax zone:\s*JACKSON/i, 'resale certificate ask did not return available tax context');
      assertText(answer, /did not find a resale or tax-exemption certificate field/i, 'resale certificate ask did not flag missing certificate evidence');
      assertNotText(answer, /^Best match:/i, 'resale certificate ask returned a generic best-match summary');
    },
  },
  {
    name: 'terms ask does not include unrequested tax context',
    question: 'terms for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assertText(answer, /\bTerms:\s*N30\b/i, 'terms ask did not answer terms');
      assertNotText(answer, /Tax zone:/i, 'terms ask leaked unrequested tax context');
    },
  },
  {
    name: 'shipping address ask does not fall back to terms/status',
    question: 'shipping address for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assert(answer.resolvedEntity?.canonicalName === 'ACME Barricades LC', 'shipping address ask did not resolve ACME');
      assertText(answer, /did not find the requested field/i, 'missing shipping address should be called out directly');
      assertNotText(answer, /Terms:|Status:\s*Active|Credit limit:/i, 'shipping address ask fell back to generic account fields');
    },
  },
  {
    name: 'bare customer summary does not use office-noise sources',
    question: 'acme summary',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.scope === 'revenue_ops', `expected revenue_ops scope, got ${answer.scope}`);
      assertText(answer, /ACME Barricades LC/i, 'bare customer summary did not resolve ACME');
      assert(
        answer.citations.every((citation) => ['acumatica', 'pipedrive'].includes(citation.source_id)),
        'bare customer summary should stay inside revenue system-of-record sources',
      );
      assertNoCitation(answer, /calendar|mail|teams|Share drive|Rig Roofing/i, 'bare customer summary leaked office-noise source');
    },
  },
  {
    name: 'informal procurement ask routes to procurement brain',
    question: 'need 12 wedge anchors for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'procurement_request', `expected procurement_request, got ${answer.intent}`);
      assert(answer.scope === 'procurement', `expected procurement scope, got ${answer.scope}`);
      assertText(answer, /structured this as a procurement request/i, 'informal procurement ask did not use procurement summary');
      assertText(answer, /ACME Barricades LC|acme/i, 'informal procurement ask did not preserve customer context');
      assertText(answer, /12\s+wedge anchors/i, 'informal procurement ask did not preserve quantity and line item');
      assertNotText(answer, /Best match:/i, 'informal procurement ask fell back to free search best-match answer');
      assertNotText(answer, /National Power|Superior Fence|Ring Power/i, 'informal procurement ask leaked unrelated search result');
      assert(
        answer.citations.every((citation) => ['acumatica', 'pipedrive'].includes(citation.source_id)),
        'informal procurement answer citations should prefer system-of-record evidence over office-noise sources',
      );
    },
  },
  {
    name: 'sales phrasing procurement ask preserves customer and line',
    question: 'can acme buy 12 wedge anchors on terms',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'procurement_request', `expected procurement_request, got ${answer.intent}`);
      assert(answer.scope === 'procurement', `expected procurement scope, got ${answer.scope}`);
      assertText(answer, /Customer:\s*ACME Barricades LC/i, 'sales procurement phrasing did not resolve customer');
      assertText(answer, /Lines:\s*12\s+wedge anchors/i, 'sales procurement phrasing did not preserve quantity and line item');
      assertNotText(answer, /Customer:\s*Missing|Lines:\s*Missing/i, 'sales procurement phrasing dropped required context');
    },
  },
  {
    name: 'source-and-order phrasing stays procurement not order lookup',
    question: 'source and order 4 boxes screws for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'procurement_request', `expected procurement_request, got ${answer.intent}`);
      assert(answer.scope === 'procurement', `expected procurement scope, got ${answer.scope}`);
      assertText(answer, /4\s+boxes\s+screws/i, 'source/order procurement ask did not preserve requested line');
      assertNotText(answer, /could not find a solid order match/i, 'source/order procurement ask was misrouted to order lookup');
    },
  },
  {
    name: 'who-sells phrasing routes to procurement not contact mail',
    question: 'who sells wedge anchors',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'procurement_request', `expected procurement_request, got ${answer.intent}`);
      assert(answer.scope === 'procurement', `expected procurement scope, got ${answer.scope}`);
      assertText(answer, /Lines:\s*wedge anchors/i, 'who-sells ask did not preserve requested item line');
      assertNotText(answer, /Fastening Specialists RMA|Best match:/i, 'who-sells ask leaked unrelated mail/search result');
      assert(answer.citations.every((citation) => citation.source_id !== 'm365-mail'), 'who-sells ask should not cite unrelated mail');
    },
  },
  {
    name: 'vendor-for item does not infer item as customer',
    question: 'vendor for wedge anchors',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'procurement_request', `expected procurement_request, got ${answer.intent}`);
      assert(answer.scope === 'procurement', `expected procurement scope, got ${answer.scope}`);
      assertText(answer, /Customer:\s*Missing/i, 'vendor-for item ask should not infer item text as a customer');
      assertText(answer, /Lines:\s*wedge anchors/i, 'vendor-for item ask did not parse item line');
      assertNotText(answer, /Fastening Specialists RMA/i, 'vendor-for item ask used unrelated mail subject as customer');
    },
  },
  {
    name: 'vendor-for exact SKU preserves SKU as requested line',
    question: 'who is the vendor for 00286',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'procurement_request', `expected procurement_request, got ${answer.intent}`);
      assert(answer.scope === 'procurement', `expected procurement scope, got ${answer.scope}`);
      assertText(answer, /Customer:\s*Missing/i, 'vendor-for SKU ask should not infer SKU as a customer');
      assertText(answer, /Lines:\s*00286/i, 'vendor-for SKU ask did not preserve exact SKU as a line');
      assertNotText(answer, /No line items were detected|Best match:|Toole's South Lake Ace Hardware/i, 'vendor-for SKU ask lost line context or leaked unrelated records');
      assert(answer.citations.every((citation) => citation.source_id === 'acumatica' && /\/item\//i.test(citation.slug)), 'vendor-for SKU ask should cite only Acumatica item evidence');
    },
  },
  {
    name: 'purchase order SKU history preserves SKU line context',
    question: 'latest purchase order for 00286',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'procurement_request', `expected procurement_request, got ${answer.intent}`);
      assert(answer.scope === 'procurement', `expected procurement scope, got ${answer.scope}`);
      assertText(answer, /Customer:\s*Missing/i, 'PO-for-SKU ask should not infer SKU as a customer');
      assertText(answer, /Lines:\s*00286/i, 'PO-for-SKU ask did not preserve exact SKU as a line');
      assertNotText(answer, /No line items were detected|Best match:|Toole's South Lake Ace Hardware/i, 'PO-for-SKU ask lost line context or leaked unrelated records');
      assert(answer.citations.every((citation) => citation.source_id === 'acumatica' && /\/item\//i.test(citation.slug)), 'PO-for-SKU ask should cite only Acumatica item evidence');
    },
  },
  {
    name: 'source item for customer preserves both contexts',
    question: 'source wedge anchors for acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'procurement_request', `expected procurement_request, got ${answer.intent}`);
      assert(answer.scope === 'procurement', `expected procurement scope, got ${answer.scope}`);
      assertText(answer, /Customer:\s*ACME Barricades LC/i, 'source-for-customer ask did not resolve customer');
      assertText(answer, /Lines:\s*wedge anchors/i, 'source-for-customer ask did not parse item line');
      assertNotText(answer, /Fastening Specialists RMA/i, 'source-for-customer ask leaked unrelated mail subject');
    },
  },
  {
    name: 'ambiguous customer shorthand asks for clarification',
    question: 'terms for power',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assert(answer.confidence === 'low', `expected low confidence for ambiguous ask, got ${answer.confidence}`);
      assert(answer.resolvedEntity?.ambiguous === true, 'ambiguous shorthand was not marked ambiguous');
      assertText(answer, /ambiguous/i, 'ambiguous shorthand did not explain ambiguity');
      assertText(answer, /Anixter Power Solutions/i, 'ambiguous shorthand did not list first plausible match');
      assertText(answer, /National Power LLC/i, 'ambiguous shorthand did not list competing plausible match');
      assertNotText(answer, /\bTerms:\s*N30\b/i, 'ambiguous shorthand answered a field instead of clarifying');
      assert(answer.citations.length === 0, 'ambiguous shorthand should not return authoritative citations');
    },
  },
  {
    name: 'generic category shorthand does not pick a random account',
    question: 'terms for hardware',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.confidence === 'low', `expected low confidence for generic hardware ask, got ${answer.confidence}`);
      assert(answer.resolvedEntity?.ambiguous === true, 'generic hardware ask was not marked ambiguous');
      assertText(answer, /ambiguous/i, 'generic hardware ask did not explain ambiguity');
      assertNotText(answer, /\bTerms:\s*N30\b/i, 'generic hardware ask answered a random account terms field');
      assert(answer.citations.length === 0, 'generic hardware ask should not return authoritative citations');
    },
  },
  {
    name: 'collaboration ask uses collaboration brain not item catalog',
    question: 'share drive and product knowledge',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'collaboration_lookup', `expected collaboration_lookup, got ${answer.intent}`);
      assert(answer.scope === 'collaboration', `expected collaboration scope, got ${answer.scope}`);
      assertText(answer, /Share drive and Product Knowledge/i, 'collaboration ask did not return the matching meeting/file context');
      assertText(answer, /\bStart:/i, 'collaboration ask did not render useful calendar fields');
      assertNotText(answer, /Flat Square Drive Wood Screws|Inventory ID/i, 'collaboration ask leaked item catalog result');
      assert(
        answer.citations.every((citation) => citation.source_id.startsWith('m365-')),
        'collaboration ask should cite only M365 collaboration sources',
      );
    },
  },
  {
    name: 'email ask does not borrow revenue records when no email match exists',
    question: 'emails about acme',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'collaboration_lookup', `expected collaboration_lookup, got ${answer.intent}`);
      assert(answer.scope === 'collaboration', `expected collaboration scope, got ${answer.scope}`);
      assert(answer.confidence === 'low', `expected low confidence for missing email match, got ${answer.confidence}`);
      assertText(answer, /could not find a solid collaboration record match/i, 'missing email ask did not refuse cleanly');
      assertNotText(answer, /ACME Barricades LC:|Terms:|Customer ID:/i, 'missing email ask borrowed revenue account data');
      assert(answer.citations.length === 0, 'missing email ask should not return unrelated citations');
    },
  },
  {
    name: 'teams ask does not borrow item catalog when no team match exists',
    question: 'teams messages about wedge anchors',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'collaboration_lookup', `expected collaboration_lookup, got ${answer.intent}`);
      assert(answer.scope === 'collaboration', `expected collaboration scope, got ${answer.scope}`);
      assert(answer.confidence === 'low', `expected low confidence for missing Teams match, got ${answer.confidence}`);
      assertText(answer, /could not find a solid collaboration record match/i, 'missing Teams ask did not refuse cleanly');
      assertNotText(answer, /Inventory ID|TIEMAX PRO/i, 'missing Teams ask borrowed item catalog data');
      assert(answer.citations.length === 0, 'missing Teams ask should not return unrelated citations');
    },
  },
  {
    name: 'latest email uses newest mail record not keyword score',
    question: 'latest email',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'collaboration_lookup', `expected collaboration_lookup, got ${answer.intent}`);
      assert(answer.scope === 'collaboration', `expected collaboration scope, got ${answer.scope}`);
      assertText(answer, /\bReceived:\s*2026-05-30T/i, 'latest email did not use the newest indexed mail date');
      assert(answer.citations.every((citation) => citation.source_id === 'm365-mail'), 'latest email should cite only mail records');
    },
  },
  {
    name: 'recent meetings prefer recent past calendar entries',
    question: 'recent meetings',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'collaboration_lookup', `expected collaboration_lookup, got ${answer.intent}`);
      assert(answer.scope === 'collaboration', `expected collaboration scope, got ${answer.scope}`);
      assertText(answer, /\bStart:\s*2026-05-/i, 'recent meetings should prefer recent past/near-current calendar events');
      assertNotText(answer, /Vacation|2026-12-28/i, 'recent meetings should not choose far-future vacation events');
      assert(answer.citations.every((citation) => citation.source_id === 'm365-calendar'), 'recent meetings should cite only calendar records');
    },
  },
  {
    name: 'upcoming meetings prefer next future calendar entry',
    question: 'upcoming meetings',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'collaboration_lookup', `expected collaboration_lookup, got ${answer.intent}`);
      assert(answer.scope === 'collaboration', `expected collaboration scope, got ${answer.scope}`);
      assertText(answer, /\bStart:\s*2026-06-01T/i, 'upcoming meetings should choose the next future calendar event');
      assertNotText(answer, /Vacation|2026-12-28/i, 'upcoming meetings should not jump to the farthest future event');
      assert(answer.citations.every((citation) => citation.source_id === 'm365-calendar'), 'upcoming meetings should cite only calendar records');
    },
  },
  {
    name: 'email from filter requires sender match',
    question: 'latest email from chris',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'collaboration_lookup', `expected collaboration_lookup, got ${answer.intent}`);
      assert(answer.scope === 'collaboration', `expected collaboration scope, got ${answer.scope}`);
      assert(answer.confidence === 'low', `expected low confidence when sender does not match, got ${answer.confidence}`);
      assertText(answer, /could not find a solid collaboration record match/i, 'sender-filtered email ask should refuse without sender match');
      assertNotText(answer, /Chris, stop screenshotting/i, 'sender-filtered email ask matched subject text instead of From header');
      assert(answer.citations.length === 0, 'sender-filtered miss should not return unrelated citations');
    },
  },
  {
    name: 'email from filter allows sender match',
    question: 'recent email from linkedin',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'collaboration_lookup', `expected collaboration_lookup, got ${answer.intent}`);
      assert(answer.scope === 'collaboration', `expected collaboration scope, got ${answer.scope}`);
      assertText(answer, /From:\s*updates-noreply@linkedin\.com/i, 'sender-filtered email ask did not match From header');
      assert(answer.citations.every((citation) => citation.source_id === 'm365-mail'), 'sender-filtered email should cite only mail records');
    },
  },
  {
    name: 'email to filter requires recipient match',
    question: 'latest email to tim@cultivusplus.com',
    assert(answer) {
      assertCleanAnswer(answer);
      assert(answer.intent === 'collaboration_lookup', `expected collaboration_lookup, got ${answer.intent}`);
      assert(answer.scope === 'collaboration', `expected collaboration scope, got ${answer.scope}`);
      assertText(answer, /To:\s*tim@cultivusplus\.com/i, 'recipient-filtered email ask did not match To header');
      assert(answer.citations.every((citation) => citation.source_id === 'm365-mail'), 'recipient-filtered email should cite only mail records');
    },
  },
];

async function runAskCases(): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const testCase of askCases) {
    if (testCase.skip) {
      results.push({ name: testCase.name, skipped: true, reason: testCase.reason ?? 'pending' });
      continue;
    }
    const answer = await askBrain({ question: testCase.question, limit: 8 });
    testCase.assert(answer);
    results.push({ name: testCase.name, ok: true });
  }
  return results;
}

async function runAgentCase(): Promise<{ name: string; ok: true }> {
  const response = await agentChat([
    'Customer: ACME Barricades LC',
    'Ship to: 1200 Industrial Way',
    'Need to source and buy 12 ea 3/8 wedge anchors',
  ].join('\n'));
  assert(response.mode === 'procurement_plan', `expected procurement_plan mode, got ${response.mode}`);
  const actionPlan = response.actionPlan;
  if (!actionPlan) throw new Error('agent did not return an action plan');
  assert(actionPlan.executionPolicy.canExecuteNow === false, 'agent should not execute write actions');
  assert(actionPlan.actions.some((action: PlannedAction) => action.system === 'acumatica'), 'agent plan has no Acumatica action');
  assertCleanAnswer(response.answer);
  assert(response.answer.intent === 'procurement_request', `expected procurement_request intent, got ${response.answer.intent}`);
  assert(response.answer.scope === 'procurement', `expected procurement scope, got ${response.answer.scope}`);
  assertText(response.answer, /ACME Barricades LC/i, 'procurement agent answer did not preserve requested customer');
  assertText(response.answer, /wedge anchors/i, 'procurement agent answer did not preserve requested line item');
  assertNotText(response.answer, /National Power|Superior Fence|Ring Power/i, 'procurement agent answer leaked unrelated search result');
  return { name: 'procurement chat plans actions without writes', ok: true };
}

async function main(): Promise<void> {
  await ensureFixtureBrain();
  const askResults = await runAskCases();
  const agentResult = await runAgentCase();
  const cases = [...askResults, agentResult];
  const skipped = cases.filter((result) => 'skipped' in result).length;
  const passed = cases.length - skipped;
  console.log(JSON.stringify({
    ok: true,
    summary: { passed, skipped, total: cases.length },
    cases,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
