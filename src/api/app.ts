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
import { getConnectorStatuses } from '../sources/status.ts';
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

export const app = new Hono();

app.use('*', cors({ origin: '*' }));

app.use('*', async (c, next) => {
  if (c.req.path === '/health') return next();
  const auth = c.req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (token !== config.COMPANY_BRAIN_API_TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
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

app.post('/search', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    query?: string;
    sources?: string[];
    limit?: number;
  };
  if (!body.query) return c.json({ error: 'query required' }, 400);
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
  if (!body.question) return c.json({ error: 'question required' }, 400);
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
  if (!body.message?.trim()) return c.json({ error: 'message required' }, 400);
  return c.json(await agentChat(body.message));
});

app.post('/agent/procurement-workflow', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    message?: string;
    submittedBy?: string;
  };
  if (!body.message?.trim()) return c.json({ error: 'message required' }, 400);
  try {
    return c.json(await createAgentProcurementWorkflow({
      message: body.message,
      submittedBy: body.submittedBy,
    }), 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 422);
  }
});

app.post('/procurement/structure', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    rawText?: string;
  };
  if (!body.rawText?.trim()) return c.json({ error: 'rawText required' }, 400);
  return c.json(await structureProcurementRequest(body.rawText));
});

app.post('/procurement/action-plan', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    rawText?: string;
  };
  if (!body.rawText?.trim()) return c.json({ error: 'rawText required' }, 400);
  return c.json(await createProcurementActionPlan(body.rawText));
});

app.post('/procurement/enrich', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    rawText?: string;
  };
  if (!body.rawText?.trim()) return c.json({ error: 'rawText required' }, 400);
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
    return c.json({ error: 'rawText or packetId required' }, 400);
  }
  try {
    return c.json(await prepareProcurementActions({
      rawText: body.rawText,
      packetId: body.packetId,
      preparedBy: body.preparedBy,
    }), 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 422);
  }
});

app.patch('/procurement/actions/:id/approve', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    approvedBy?: string;
    note?: string;
  };
  try {
    const action = approvePreparedProcurementAction(c.req.param('id'), body);
    if (!action) return c.json({ error: 'prepared action not found' }, 404);
    return c.json(action);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 422);
  }
});

app.patch('/procurement/actions/:id/reject', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    rejectedBy?: string;
    reason?: string;
  };
  try {
    const action = rejectPreparedProcurementAction(c.req.param('id'), body);
    if (!action) return c.json({ error: 'prepared action not found' }, 404);
    return c.json(action);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 422);
  }
});

app.post('/procurement/actions/:id/execute', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    requestedBy?: string;
  };
  try {
    const action = requestProcurementActionExecution(c.req.param('id'), body);
    if (!action) return c.json({ error: 'prepared action not found' }, 404);
    return c.json(action);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 422);
  }
});

app.get('/procurement/packets', (c) => c.json({ packets: listProcurementPackets() }));

app.post('/procurement/packets', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    rawText?: string;
    submittedBy?: string;
  };
  if (!body.rawText?.trim()) return c.json({ error: 'rawText required' }, 400);
  return c.json(await createProcurementPacket({
    rawText: body.rawText,
    submittedBy: body.submittedBy,
  }), 201);
});

app.get('/procurement/packets/:id', (c) => {
  const packet = getProcurementPacket(c.req.param('id'));
  if (!packet) return c.json({ error: 'packet not found' }, 404);
  return c.json(packet);
});

app.patch('/procurement/packets/:id', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    status?: string;
    note?: { actor?: string; body?: string };
  };
  try {
    const packet = updateProcurementPacket(c.req.param('id'), body);
    if (!packet) return c.json({ error: 'packet not found' }, 404);
    return c.json(packet);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 422);
  }
});
