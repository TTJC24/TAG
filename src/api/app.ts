import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config } from '../config.ts';
import { openEngine } from '../engine.ts';
import { askBrain } from '../ask.ts';
import type { MemoryScope } from '../memory.ts';
import { agentChat, createAgentProcurementWorkflow } from '../agent/chat.ts';
import { getBrainStatus } from '../brainStatus.ts';
import { hybridSearch } from '../gbrainCompat.ts';
import { listConnectorIds } from '../sources/registry.ts';
import { getConnectorStatuses, type ConnectorStatus } from '../sources/status.ts';
import { structureProcurementRequest } from '../procurement/structure.ts';
import {
  createProcurementPacket,
  getProcurementPacket,
  listProcurementPackets,
  updateProcurementPacket,
} from '../procurement/packets.ts';
import { createProcurementActionPlan } from '../procurement/actionPlan.ts';
import {
  approvePreparedProcurementAction,
  listPreparedProcurementActions,
  prepareProcurementActions,
  rejectPreparedProcurementAction,
  requestProcurementActionExecution,
} from '../procurement/actions.ts';
import { enrichProcurementRequest } from '../procurement/enrichment.ts';

type ErrStatus = 400 | 401 | 404 | 422 | 500;

// Consistent error shape across all API responses: { error, status, hint? }
// Always use this helper instead of c.json({ error: ... }, code) directly.
const err = (c: any, status: ErrStatus, message: string, hint?: string) =>
  c.json({ error: message, status, ...(hint ? { hint } : {}) }, status);

export const app = new Hono();

app.use('*', cors({ origin: '*' }));

app.onError((e, c) => {
  console.error('[api]', c.req.method, c.req.path, e);
  const msg = e instanceof Error ? e.message : String(e);
  return err(c, 500, msg, 'Run `bun run doctor` to check connectors and env.');
});

app.use('*', async (c, next) => {
  if (c.req.path === '/health') return next();
  const auth = c.req.header('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) {
    c.header('WWW-Authenticate', 'Bearer realm="company-brain"');
    return err(
      c,
      401,
      'unauthorized',
      'Send Authorization: Bearer <token>; token comes from COMPANY_BRAIN_API_TOKEN in .env (default for local dev is `dev-local-token`).',
    );
  }
  const token = auth.slice('Bearer '.length);
  if (token !== config.COMPANY_BRAIN_API_TOKEN) {
    c.header('WWW-Authenticate', 'Bearer realm="company-brain", error="invalid_token"');
    return err(
      c,
      401,
      'unauthorized',
      'Token does not match COMPANY_BRAIN_API_TOKEN — check .env or restart the API after editing.',
    );
  }
  return next();
});

app.get('/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

app.get('/sources', async (c) => c.json({
  sources: listConnectorIds(),
  connectors: await getConnectorStatuses(),
}));

app.get('/status', async (c) => c.json(await getBrainStatus()));

app.get('/connectors/status', async (c) => c.json({ connectors: await getConnectorStatuses() }));

// Mirrors the CLI `bun run doctor` JSON output and adds aggregate summary +
// reverse-lookup of missing env keys -> connector ids that need them.
async function buildDoctorReport(): Promise<{
  ok: boolean;
  connectors: Array<{ id: string; status: 'live' | 'fixtures' | 'broken'; missingEnv: string[]; docCount?: number }>;
  missingEnvByKey: Record<string, string[]>;
  summary: { live: number; fixtures: number; broken: number };
}> {
  const statuses: ConnectorStatus[] = await getConnectorStatuses();
  const connectorsOut = statuses.map((s) => {
    const status: 'live' | 'fixtures' | 'broken' = s.liveReady
      ? 'live'
      : s.fixtureAvailable
        ? 'fixtures'
        : 'broken';
    return {
      id: s.id,
      status,
      missingEnv: s.missingEnv,
      docCount: s.documentCount,
    };
  });
  const missingEnvByKey: Record<string, string[]> = {};
  for (const s of statuses) {
    for (const key of s.missingEnv) {
      const existing = missingEnvByKey[key];
      if (existing) existing.push(s.id);
      else missingEnvByKey[key] = [s.id];
    }
  }
  const live = connectorsOut.filter((c) => c.status === 'live').length;
  const fixtures = connectorsOut.filter((c) => c.status === 'fixtures').length;
  const broken = connectorsOut.filter((c) => c.status === 'broken').length;
  return {
    ok: statuses.every((s) => s.fixtureAvailable),
    connectors: connectorsOut,
    missingEnvByKey,
    summary: { live, fixtures, broken },
  };
}

app.get('/doctor', async (c) => c.json(await buildDoctorReport()));

app.post('/search', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    query?: string;
    sources?: string[];
    limit?: number;
  };
  if (!body.query) return err(c, 400, 'query required', 'POST JSON body must include `query`');
  const engine = await openEngine();
  try {
    const hits = await hybridSearch(engine, body.query, {
      limit: body.limit ?? 10,
      sourceIds: body.sources && body.sources.length > 0 ? body.sources : undefined,
    });
    return c.json({ hits });
  } finally {
    await engine.disconnect();
  }
});

app.post('/ask', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    question?: string;
    sources?: string[];
    entity?: MemoryScope;
    limit?: number;
  };
  if (!body.question) return err(c, 400, 'question required', 'POST JSON body must include `question`');
  const answer = await askBrain({
    question: body.question,
    sources: body.sources,
    entity: body.entity,
    limit: body.limit,
  });
  return c.json(answer);
});

app.post('/agent/chat', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    message?: string;
  };
  if (!body.message?.trim()) return err(c, 400, 'message required', 'POST JSON body must include `message`');
  return c.json(await agentChat(body.message));
});

app.post('/agent/procurement-workflow', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    message?: string;
    submittedBy?: string;
  };
  if (!body.message?.trim()) return err(c, 400, 'message required', 'POST JSON body must include `message`');
  try {
    return c.json(await createAgentProcurementWorkflow({
      message: body.message,
      submittedBy: body.submittedBy,
    }), 201);
  } catch (e) {
    return err(c, 422, e instanceof Error ? e.message : String(e));
  }
});

app.post('/procurement/structure', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    rawText?: string;
  };
  if (!body.rawText?.trim()) return err(c, 400, 'rawText required', 'POST JSON body must include `rawText`');
  return c.json(await structureProcurementRequest(body.rawText));
});

app.post('/procurement/action-plan', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    rawText?: string;
  };
  if (!body.rawText?.trim()) return err(c, 400, 'rawText required', 'POST JSON body must include `rawText`');
  return c.json(await createProcurementActionPlan(body.rawText));
});

app.post('/procurement/enrich', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    rawText?: string;
  };
  if (!body.rawText?.trim()) return err(c, 400, 'rawText required', 'POST JSON body must include `rawText`');
  return c.json(await enrichProcurementRequest(body.rawText));
});

app.get('/procurement/actions', (c) => {
  const packetId = c.req.query('packetId') || undefined;
  return c.json({ actions: listPreparedProcurementActions(packetId) });
});

app.post('/procurement/actions/prepare', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    rawText?: string;
    packetId?: string;
    preparedBy?: string;
  };
  if (!body.rawText?.trim() && !body.packetId?.trim()) {
    return err(c, 400, 'rawText or packetId required', 'POST JSON body must include `rawText` or `packetId`');
  }
  try {
    return c.json(await prepareProcurementActions({
      rawText: body.rawText,
      packetId: body.packetId,
      preparedBy: body.preparedBy,
    }), 201);
  } catch (e) {
    return err(c, 422, e instanceof Error ? e.message : String(e));
  }
});

app.patch('/procurement/actions/:id/approve', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    approvedBy?: string;
    note?: string;
  };
  try {
    const action = approvePreparedProcurementAction(c.req.param('id'), body);
    if (!action) return err(c, 404, 'prepared action not found', 'Check id with GET /procurement/actions');
    return c.json(action);
  } catch (e) {
    return err(c, 422, e instanceof Error ? e.message : String(e));
  }
});

app.patch('/procurement/actions/:id/reject', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    rejectedBy?: string;
    reason?: string;
  };
  try {
    const action = rejectPreparedProcurementAction(c.req.param('id'), body);
    if (!action) return err(c, 404, 'prepared action not found', 'Check id with GET /procurement/actions');
    return c.json(action);
  } catch (e) {
    return err(c, 422, e instanceof Error ? e.message : String(e));
  }
});

app.post('/procurement/actions/:id/execute', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    requestedBy?: string;
  };
  try {
    const action = requestProcurementActionExecution(c.req.param('id'), body);
    if (!action) return err(c, 404, 'prepared action not found', 'Check id with GET /procurement/actions');
    return c.json(action);
  } catch (e) {
    return err(c, 422, e instanceof Error ? e.message : String(e));
  }
});

app.get('/procurement/packets', (c) => c.json({ packets: listProcurementPackets() }));

app.post('/procurement/packets', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    rawText?: string;
    submittedBy?: string;
  };
  if (!body.rawText?.trim()) return err(c, 400, 'rawText required', 'POST JSON body must include `rawText`');
  return c.json(await createProcurementPacket({
    rawText: body.rawText,
    submittedBy: body.submittedBy,
  }), 201);
});

app.get('/procurement/packets/:id', (c) => {
  const packet = getProcurementPacket(c.req.param('id'));
  if (!packet) return err(c, 404, 'packet not found', 'Check id with GET /procurement/packets');
  return c.json(packet);
});

app.patch('/procurement/packets/:id', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    status?: string;
    note?: { actor?: string; body?: string };
  };
  try {
    const packet = updateProcurementPacket(c.req.param('id'), body);
    if (!packet) return err(c, 404, 'packet not found', 'Check id with GET /procurement/packets');
    return c.json(packet);
  } catch (e) {
    return err(c, 422, e instanceof Error ? e.message : String(e));
  }
});

app.notFound((c) => err(c, 404, `route not found: ${c.req.method} ${c.req.path}`, 'See README for valid routes.'));
