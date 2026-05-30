#!/usr/bin/env node
import { config } from '../config.ts';
import { app } from '../api/app.ts';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  return {
    Authorization: `Bearer ${config.COMPANY_BRAIN_API_TOKEN}`,
    ...extra,
  };
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw new Error(`Expected HTTP 2xx, got ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  const health = await json<{ ok: boolean }>(await app.request('/health'));
  assert(health.ok, 'Health endpoint did not return ok');

  const unauthorized = await app.request('/connectors/status');
  assert(unauthorized.status === 401, `Expected unauthorized status, got ${unauthorized.status}`);

  const connectorData = await json<{
    connectors: Array<{ id: string; fixtureAvailable: boolean; documentCount: number }>;
  }>(await app.request('/connectors/status', { headers: authHeaders() }));
  assert(connectorData.connectors.length === 10, `Expected 10 connectors, got ${connectorData.connectors.length}`);
  for (const id of ['supermemory-fs', 'supermemory-blcs', 'supermemory-usa', 'supermemory-shared']) {
    assert(connectorData.connectors.some((connector) => connector.id === id), `Missing ${id} connector`);
  }
  for (const connector of connectorData.connectors) {
    if (connector.id.startsWith('supermemory-')) {
      continue;
    } else {
      assert(connector.fixtureAvailable, `${connector.id} fixture is unavailable`);
      assert(connector.documentCount > 0, `${connector.id} has no indexed fixture docs`);
    }
  }

  const search = await json<{ hits: unknown[] }>(await app.request('/search', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ query: 'Acme pump', limit: 3 }),
  }));
  assert(search.hits.length > 0, 'Search returned no hits');

  const answer = await json<{
    text: string;
    citations: unknown[];
    memories: unknown[];
    intent: string;
    confidence: string;
    resolvedEntity: null | { canonicalName: string | null; aliases: string[] };
  }>(await app.request('/ask', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ question: 'What are Acme pump terms?', limit: 5 }),
  }));
  assert(answer.text.length > 0, 'Ask returned empty text');
  assert(!answer.text.includes('Found ') || !answer.text.includes('chunk'), 'Ask should not expose raw chunk-count answer text');
  assert(!answer.text.includes('**'), 'Ask should not expose markdown field markup');
  assert(!answer.text.includes('## Fields'), 'Ask should not expose indexed document headings');
  assert(/Terms:/i.test(answer.text), 'Ask did not answer the requested terms field');
  assert(!answer.text.includes('Best match:') || answer.text.indexOf('Terms:') < answer.text.indexOf('\n- Customer'), 'Ask should lead with the requested field');
  assert(answer.intent.length > 0, 'Ask did not return inferred intent');
  assert(answer.confidence.length > 0, 'Ask did not return confidence');
  assert(answer.resolvedEntity?.canonicalName, 'Ask did not return a resolved entity for Acme terms');
  assert(answer.citations.length > 0, 'Ask returned no citations');
  assert(Array.isArray(answer.memories), 'Ask did not return memories array');
  assert(!answer.text.includes('Memory context'), 'Ask should not expose memory context as rendered answer text');

  const entityAnswer = await json<{ text: string; memories: unknown[] }>(await app.request('/ask', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ question: 'What are Acme pump terms?', entity: 'fs', limit: 5 }),
  }));
  assert(entityAnswer.text.length > 0, 'Entity-scoped ask returned empty text');
  assert(Array.isArray(entityAnswer.memories), 'Entity-scoped ask did not return memories array');

  const ownerAnswer = await json<{ text: string; intent: string }>(await app.request('/ask', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ question: 'who owns acme?', limit: 5 }),
  }));
  assert(ownerAnswer.intent === 'contact_lookup', `Expected contact_lookup intent, got ${ownerAnswer.intent}`);
  assert(ownerAnswer.text.includes('Tim Clark'), 'Owner answer did not resolve owner name');
  assert(ownerAnswer.text.includes('Owner:'), 'Owner answer did not label the resolved owner as Owner');
  assert(!ownerAnswer.text.includes('Owner ID: {'), 'Owner answer exposed unresolved owner object');
  assert(!ownerAnswer.text.includes('{"id"'), 'Owner answer exposed raw JSON');

  const missingItemAnswer = await json<{ text: string; confidence: string }>(await app.request('/ask', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ question: 'price for pump a14', limit: 5 }),
  }));
  assert(missingItemAnswer.confidence === 'low', 'Missing item answer should be low confidence');
  assert(missingItemAnswer.text.includes('could not find a solid item match'), 'Missing item answer should refuse weak item match');

  const agent = await json<{
    mode: string;
    answer: { text: string; citations: unknown[] };
    actionPlan: null | { actions: unknown[]; executionPolicy: { canExecuteNow: boolean } };
    suggestedNextStep: string;
  }>(await app.request('/agent/chat', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      message: [
        'Customer: ACME Barricades LC',
        'Ship to: 1200 Industrial Way',
        'Need to source and buy 12 ea 3/8 wedge anchors',
      ].join('\n'),
    }),
  }));
  assert(agent.mode === 'procurement_plan', `Expected procurement_plan mode, got ${agent.mode}`);
  assert(agent.answer.text.length > 0, 'Agent answer returned empty text');
  if (agent.actionPlan === null) throw new Error('Agent did not return procurement action plan');
  const agentActionPlan = agent.actionPlan;
  assert(agentActionPlan.actions.length >= 4, 'Agent action plan returned too few actions');
  assert(agentActionPlan.executionPolicy.canExecuteNow === false, 'Agent should not execute writes yet');
  assert(agent.suggestedNextStep.length > 0, 'Agent did not return a suggested next step');

  const agentWorkflow = await json<{
    packet: { id: string; status: string };
    preparedActions: Array<{ id: string; execution: { canExecuteNow: boolean } }>;
    enrichment: { acumatica: { customerCandidates: unknown[] } };
    reviewUrlHint: string;
  }>(await app.request('/agent/procurement-workflow', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      message: [
        'Customer: ACME Barricades LC',
        'Ship to: 1200 Industrial Way',
        'Need to source and buy 12 ea 3/8 wedge anchors',
      ].join('\n'),
      submittedBy: 'api_smoke',
    }),
  }));
  assert(agentWorkflow.packet.id, 'Agent workflow did not create a packet');
  assert(agentWorkflow.preparedActions.length >= 3, 'Agent workflow did not prepare enough actions');
  assert(
    agentWorkflow.preparedActions.every((action) => action.execution.canExecuteNow === false),
    'Agent workflow prepared actions must not execute writes',
  );
  assert(
    agentWorkflow.enrichment.acumatica.customerCandidates.length > 0,
    'Agent workflow did not include Acumatica enrichment',
  );
  assert(agentWorkflow.reviewUrlHint.includes(agentWorkflow.packet.id), 'Agent workflow did not return review hint');

  const procurement = await json<{
    fields: { customerName: string | null; shipTo: string | null };
    lines: unknown[];
    confidence: number;
    evidence: { customer: unknown[]; lines: Array<{ hits: unknown[] }> };
  }>(await app.request('/procurement/structure', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      rawText: [
        'Customer: ACME Barricades LC',
        'Ship to: 1200 Industrial Way',
        'Items:',
        '- 12 ea 3/8 wedge anchors',
        '- 4 boxes self drilling screws',
      ].join('\n'),
    }),
  }));
  assert(procurement.fields.customerName === 'ACME Barricades LC', 'Procurement parser missed customer');
  assert(procurement.fields.shipTo === '1200 Industrial Way', 'Procurement parser missed ship-to');
  assert(procurement.lines.length === 2, `Expected 2 procurement lines, got ${procurement.lines.length}`);
  assert(procurement.confidence > 0, 'Procurement confidence was not computed');
  assert(procurement.evidence.customer.length > 0, 'Procurement customer evidence returned no hits');
  assert(procurement.evidence.lines.some((line) => line.hits.length > 0), 'Procurement line evidence returned no hits');

  const actionPlan = await json<{
    actions: Array<{ id: string; system: string; status: string; requiresApproval: boolean }>;
    executionPolicy: { canExecuteNow: boolean };
  }>(await app.request('/procurement/action-plan', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      rawText: [
        'Customer: ACME Barricades LC',
        'Ship to: 1200 Industrial Way',
        'Items:',
        '- 12 ea 3/8 wedge anchors',
      ].join('\n'),
    }),
  }));
  assert(actionPlan.actions.length >= 4, 'Procurement action plan returned too few actions');
  assert(actionPlan.actions.some((action) => action.system === 'acumatica'), 'Procurement action plan has no Acumatica action');
  assert(actionPlan.actions.some((action) => action.requiresApproval), 'Procurement action plan has no approval-gated actions');
  assert(actionPlan.executionPolicy.canExecuteNow === false, 'Procurement action plan should not execute writes yet');

  const enrichment = await json<{
    acumatica: {
      customerCandidates: unknown[];
      lineItems: Array<{ itemCandidates: unknown[] }>;
      recentOrders: unknown[];
      recentInvoices: unknown[];
    };
    warnings: string[];
  }>(await app.request('/procurement/enrich', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      rawText: [
        'Customer: ACME Barricades LC',
        'Ship to: 1200 Industrial Way',
        'Items:',
        '- 12 ea 3/8 wedge anchors',
      ].join('\n'),
    }),
  }));
  assert(
    enrichment.acumatica.customerCandidates.length > 0,
    'Acumatica enrichment returned no customer candidates',
  );
  assert(enrichment.acumatica.lineItems.length === 1, 'Acumatica enrichment did not preserve line item shape');

  const packet = await json<{
    id: string;
    status: string;
    notes: unknown[];
    structure: { lines: unknown[] };
  }>(await app.request('/procurement/packets', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      rawText: [
        'Customer: ACME Barricades LC',
        'Ship to: 1200 Industrial Way',
        'Items:',
        '- 12 ea 3/8 wedge anchors',
      ].join('\n'),
      submittedBy: 'api_smoke',
    }),
  }));
  assert(packet.id, 'Procurement packet was not assigned an id');
  assert(packet.structure.lines.length === 1, 'Procurement packet did not snapshot structured lines');

  const updatedPacket = await json<{ status: string; notes: unknown[] }>(await app.request(`/procurement/packets/${packet.id}`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      status: 'ready_for_sourcing',
      note: { actor: 'api_smoke', body: 'Smoke test review note.' },
    }),
  }));
  assert(updatedPacket.status === 'ready_for_sourcing', 'Procurement packet status did not update');
  assert(updatedPacket.notes.length > 0, 'Procurement packet note did not save');

  const packetList = await json<{ packets: Array<{ id: string }> }>(
    await app.request('/procurement/packets', { headers: authHeaders() }),
  );
  assert(packetList.packets.some((item) => item.id === packet.id), 'Procurement packet was not listed');

  const prepared = await json<{
    preparedActions: Array<{
      id: string;
      plannedActionId: string;
      status: string;
      requiresApproval: boolean;
      execution: { canExecuteNow: boolean };
      payloadPreview: Record<string, unknown>;
    }>;
  }>(await app.request('/procurement/actions/prepare', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      packetId: packet.id,
      preparedBy: 'api_smoke',
    }),
  }));
  assert(prepared.preparedActions.length >= 3, 'Prepared action ledger returned too few actions');
  assert(
    prepared.preparedActions.every((action) => action.execution.canExecuteNow === false),
    'Prepared action ledger must not execute writes',
  );
  const acumaticaDraft = prepared.preparedActions.find((action) => action.plannedActionId === 'prepare-acumatica-draft');
  assert(acumaticaDraft, 'Prepared action ledger did not include Acumatica draft preview');
  if (!acumaticaDraft) throw new Error('Prepared action ledger did not include Acumatica draft preview');
  assert(acumaticaDraft.payloadPreview.guardrail, 'Acumatica draft preview did not include a guardrail');
  assert(acumaticaDraft.payloadPreview.acumaticaContext, 'Acumatica draft preview did not include enrichment context');

  const approvedAction = await json<{ status: string; approvedBy: string | null }>(
    await app.request(`/procurement/actions/${acumaticaDraft.id}/approve`, {
      method: 'PATCH',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ approvedBy: 'api_smoke', note: 'Approve preview for smoke coverage.' }),
    }),
  );
  assert(approvedAction.status === 'approved', 'Prepared action did not record approval');
  assert(approvedAction.approvedBy === 'api_smoke', 'Prepared action approval actor was not saved');

  const executionAttempt = await json<{
    status: string;
    executionAttempts: Array<{ status: string; externalWritePerformed: boolean; adapter: string }>;
  }>(await app.request(`/procurement/actions/${acumaticaDraft.id}/execute`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ requestedBy: 'api_smoke' }),
  }));
  assert(executionAttempt.status === 'approved', 'Execution attempt should not change approval status');
  assert(executionAttempt.executionAttempts.length > 0, 'Execution attempt was not recorded');
  assert(
    executionAttempt.executionAttempts[0]?.externalWritePerformed === false,
    'Execution attempt must not perform external writes',
  );
  assert(
    executionAttempt.executionAttempts[0]?.adapter === 'acumatica.draft_hold_writer',
    'Execution attempt did not target the expected Acumatica adapter boundary',
  );

  console.log(JSON.stringify({
    ok: true,
    connectors: connectorData.connectors.length,
    searchHits: search.hits.length,
    citations: answer.citations.length,
    agentMode: agent.mode,
    agentWorkflowPreparedActions: agentWorkflow.preparedActions.length,
    procurementLines: procurement.lines.length,
    procurementCustomerEvidence: procurement.evidence.customer.length,
    procurementActions: actionPlan.actions.length,
    acumaticaCustomerCandidates: enrichment.acumatica.customerCandidates.length,
    procurementPacketStatus: updatedPacket.status,
    preparedActions: prepared.preparedActions.length,
    approvedActionStatus: approvedAction.status,
    executionAttemptStatus: executionAttempt.executionAttempts[0]?.status,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
