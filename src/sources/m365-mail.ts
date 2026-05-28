import { readFileSync } from 'node:fs';
import {
  computeContentHash,
  type IngestionSource,
  type IngestionSourceContext,
} from 'gbrain/ingestion';
import type { ConnectorSpec } from './types.ts';
import { fetchMailMessages } from './m365/graph.ts';

const SOURCE_ID = 'm365-mail';
const SOURCE_KIND = 'm365-mail';
const FIXTURE_PATH = 'fixtures/m365-mail/messages.json';

export interface MailMessage {
  id: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  received_at: string;
  body_preview: string | null;
  conversation_id: string | null;
  web_link: string | null;
}

function slugFor(m: MailMessage): string {
  const day = m.received_at.slice(0, 10);
  const short = computeContentHash(m.id).slice(0, 10);
  return `mail/m365/${day}-${short}`;
}

function sourceUri(m: MailMessage): string {
  return `m365-mail://message/${encodeURIComponent(m.id)}`;
}

function clean(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/\s+/g, ' ').trim().slice(0, 1200);
}

function markdownFor(m: MailMessage): string {
  const to = m.to.length ? m.to.join(', ') : '(none)';
  const cc = m.cc.length ? m.cc.join(', ') : '(none)';
  const preview = clean(m.body_preview);
  return `---
type: note
title: "${m.subject.replaceAll('"', '\\"')}"
mail_message_id: "${m.id.replaceAll('"', '\\"')}"
source_uri: "${sourceUri(m)}"
source_kind: "${SOURCE_KIND}"
conversation_id: "${m.conversation_id ?? ''}"
received_at: "${m.received_at}"
mail_from: "${m.from.replaceAll('"', '\\"')}"
---

# ${m.subject}

- Source: ${sourceUri(m)}
- From: ${m.from}
- To: ${to}
- Cc: ${cc}
- Received: ${m.received_at}
${m.web_link ? `- Web link: ${m.web_link}` : ''}

${preview ? `## Body Preview\n\n${preview}\n` : ''}
`;
}

class M365MailSource implements IngestionSource {
  readonly id = SOURCE_ID;
  readonly kind = SOURCE_KIND;
  readonly mode = 'migration' as const;

  constructor(private readonly messages: MailMessage[]) {}

  async start(ctx: IngestionSourceContext): Promise<void> {
    for (const msg of this.messages) {
      const content = markdownFor(msg);
      ctx.emit({
        source_id: this.id,
        source_kind: this.kind,
        source_uri: sourceUri(msg),
        received_at: new Date().toISOString(),
        content_type: 'text/markdown',
        content,
        content_hash: computeContentHash(content),
        untrusted_payload: false,
        metadata: {
          slug: slugFor(msg),
          message_id: msg.id,
          conversation_id: msg.conversation_id,
          mail_received_at: msg.received_at,
        },
      });
    }
  }

  async stop(): Promise<void> {}
}

async function loadMessages(dryRun: boolean): Promise<MailMessage[]> {
  if (dryRun) {
    return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as MailMessage[];
  }
  return await fetchMailMessages();
}

export const m365MailConnector: ConnectorSpec = {
  id: SOURCE_ID,
  displayName: 'M365 Mail',
  kind: SOURCE_KIND,
  async build({ dryRun }) {
    const messages = await loadMessages(dryRun);
    return new M365MailSource(messages);
  },
};
