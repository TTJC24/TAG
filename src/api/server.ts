#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { config } from '../config.ts';
import { app } from './app.ts';

const port = config.COMPANY_BRAIN_API_PORT;
console.log(`company-brain api listening on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
