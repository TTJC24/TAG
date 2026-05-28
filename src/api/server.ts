#!/usr/bin/env bun
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { config } from '../config.ts';
import { openEngine } from '../engine.ts';
import { askBrain } from '../ask.ts';
import { hybridSearch } from 'gbrain/search/hybrid';
import { listConnectorIds } from '../sources/registry.ts';

const app = new Hono();

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

app.get('/sources', (c) => c.json({ sources: listConnectorIds() }));

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
    limit?: number;
  };
  if (!body.question) return c.json({ error: 'question required' }, 400);
  const answer = await askBrain({
    question: body.question,
    sources: body.sources,
    limit: body.limit,
  });
  return c.json(answer);
});

const port = config.COMPANY_BRAIN_API_PORT;
console.log(`company-brain api listening on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
