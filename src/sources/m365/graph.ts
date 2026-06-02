import { ConfidentialClientApplication } from '@azure/msal-node';
import { config, requireEnv } from '../../config.ts';
import type { CalendarEvent } from '../m365-calendar.ts';
import type { MailMessage } from '../m365-mail.ts';
import type { SharePointItem } from '../m365-sharepoint.ts';
import type { TeamsThread } from '../m365-teams.ts';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const tenant = requireEnv('M365_TENANT_ID');
  const clientId = requireEnv('M365_CLIENT_ID');
  const clientSecret = requireEnv('M365_CLIENT_SECRET');

  const app = new ConfidentialClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenant}`,
      clientSecret,
    },
  });
  let result;
  try {
    result = await app.acquireTokenByClientCredential({
      scopes: ['https://graph.microsoft.com/.default'],
    });
  } catch (err) {
    const e = err as { errorCode?: string; errorMessage?: string; correlationId?: string; message?: string };
    const parts = [
      e.errorCode ? `errorCode=${e.errorCode}` : null,
      e.errorMessage ? `errorMessage=${e.errorMessage}` : (e.message ?? null),
      e.correlationId ? `correlationId=${e.correlationId}` : null,
    ].filter(Boolean);
    throw new Error(
      `Failed to acquire M365 token: ${parts.join('; ') || String(err)}. Check M365_CLIENT_ID / M365_CLIENT_SECRET / M365_TENANT_ID in .env.`,
    );
  }
  if (!result?.accessToken) {
    throw new Error(
      'Failed to acquire M365 token: no access token returned. Check M365_CLIENT_ID / M365_CLIENT_SECRET / M365_TENANT_ID in .env.',
    );
  }
  cachedToken = {
    token: result.accessToken,
    expiresAt: result.expiresOn?.getTime() ?? Date.now() + 30 * 60_000,
  };
  return cachedToken.token;
}

function graphErrorHint(status: number, path: string, retryAfter: string | null): string {
  switch (status) {
    case 401:
      return 'Bearer token rejected — secret may have rotated; check M365_CLIENT_SECRET.';
    case 403:
      return `Graph permission denied for ${path} — grant the missing application permission (Mail.Read for /messages, Sites.Read.All for /sites) in Entra and admin-consent.`;
    case 404:
      return `Resource not found for ${path} — check M365_USER_PRINCIPAL_NAME.`;
    case 429:
      return retryAfter
        ? `Throttled by Graph — Retry-After: ${retryAfter}s.`
        : 'Throttled by Graph — no Retry-After header provided.';
    default:
      return '';
  }
}

async function graphFetch<T>(path: string): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    const hint = graphErrorHint(res.status, path, res.headers.get('retry-after'));
    throw new Error(`Graph ${path} ${res.status}: ${body.slice(0, 500)}${hint ? ` — ${hint}` : ''}`);
  }
  return (await res.json()) as T;
}

async function graphFetchAbsolute<T>(url: string): Promise<T> {
  const token = await getToken();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    const hint = graphErrorHint(res.status, url, res.headers.get('retry-after'));
    throw new Error(`Graph ${url} ${res.status}: ${body.slice(0, 500)}${hint ? ` — ${hint}` : ''}`);
  }
  return (await res.json()) as T;
}

async function graphDownloadText(path: string, maxBytes: number): Promise<string | null> {
  const token = await getToken();
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    if (res.status === 404 || res.status === 415) return null;
    const body = await res.text();
    const hint = graphErrorHint(res.status, path, res.headers.get('retry-after'));
    throw new Error(`Graph download ${path} ${res.status}: ${body.slice(0, 500)}${hint ? ` — ${hint}` : ''}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!/text|json|xml|csv|html|markdown/i.test(contentType)) return null;
  const text = await res.text();
  return text.slice(0, maxBytes);
}

function isPlainTextDownload(item: { name?: string; file?: { mimeType?: string } }): boolean {
  const mimeType = item.file?.mimeType ?? '';
  const name = item.name ?? '';
  if (/\.(docx|xlsx|pptx|doc|xls|ppt|pdf)$/i.test(name)) return false;
  return /text|json|xml|csv|html|markdown/i.test(mimeType);
}

async function graphPages<TItem>(path: string, max = config.M365_MAX_ITEMS): Promise<TItem[]> {
  const items: TItem[] = [];
  let next: string | undefined = path;
  while (next && items.length < max) {
    const page: { value: TItem[]; '@odata.nextLink'?: string } = next.startsWith('http')
      ? await graphFetchAbsolute(next)
      : await graphFetch(next);
    items.push(...page.value);
    next = page['@odata.nextLink'];
  }
  return items.slice(0, max);
}

function configuredUsers(): string[] {
  const raw = config.M365_USER_PRINCIPAL_NAMES || config.M365_USER_PRINCIPAL_NAME || '';
  const users = raw
    .split(/[\n,;]+/)
    .map((user) => user.trim())
    .filter(Boolean);
  if (users.length === 0) {
    throw new Error(
      'Missing M365 user principal name(s). Set M365_USER_PRINCIPAL_NAME=user@contoso.com (single mailbox) or M365_USER_PRINCIPAL_NAMES="a@x.com, b@x.com" (multiple) in .env.',
    );
  }
  return [...new Set(users)];
}

export async function fetchCalendarEvents(): Promise<CalendarEvent[]> {
  type GraphEvent = {
    id: string;
    subject: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
    type?: string;
    responseStatus?: { response?: string };
    organizer?: { emailAddress?: { name?: string; address?: string } };
    location?: { displayName?: string };
    attendees?: Array<{ emailAddress?: { name?: string; address?: string } }>;
    bodyPreview?: string;
  };
  const events: CalendarEvent[] = [];
  for (const upn of configuredUsers()) {
    try {
      const path = `/users/${encodeURIComponent(upn)}/calendar/events?$top=50&$orderby=start/dateTime%20desc`;
      const items = await graphPages<GraphEvent>(path);
      events.push(...items.map((g) => ({
        id: g.id,
        mailbox_upn: upn,
        subject: g.subject,
        start: g.start.dateTime,
        end: g.end.dateTime,
        timezone: g.start.timeZone,
        type: g.type,
        response: g.responseStatus?.response,
        organizer: g.organizer?.emailAddress?.address ?? g.organizer?.emailAddress?.name,
        location: g.location?.displayName ?? '',
        attendees: g.attendees?.map((a) => a.emailAddress?.address ?? a.emailAddress?.name ?? '').filter(Boolean),
        body_preview: g.bodyPreview ?? null,
      })));
    } catch (err) {
      console.warn(`[m365-calendar] skipped ${upn}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return events;
}

export async function fetchMailMessages(): Promise<MailMessage[]> {
  type GraphMessage = {
    id: string;
    subject: string;
    from?: { emailAddress?: { name?: string; address?: string } };
    toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
    ccRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
    receivedDateTime: string;
    bodyPreview?: string;
    conversationId?: string;
    webLink?: string;
  };
  const messages: MailMessage[] = [];
  for (const upn of configuredUsers()) {
    try {
      const path = `/users/${encodeURIComponent(upn)}/messages?$top=50&$orderby=receivedDateTime%20desc&$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,conversationId,webLink`;
      const items = await graphPages<GraphMessage>(path);
      messages.push(...items.map((m) => ({
        id: m.id,
        mailbox_upn: upn,
        subject: m.subject,
        from: m.from?.emailAddress?.address ?? m.from?.emailAddress?.name ?? '',
        to: m.toRecipients?.map((r) => r.emailAddress?.address ?? '').filter(Boolean) ?? [],
        cc: m.ccRecipients?.map((r) => r.emailAddress?.address ?? '').filter(Boolean) ?? [],
        received_at: m.receivedDateTime,
        body_preview: m.bodyPreview ?? null,
        conversation_id: m.conversationId ?? null,
        web_link: m.webLink ?? null,
      })));
    } catch (err) {
      console.warn(`[m365-mail] skipped ${upn}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return messages;
}

export async function fetchSharePointItems(): Promise<SharePointItem[]> {
  const sites = await graphPages<{ id: string; name: string; webUrl: string }>(`/sites?search=*&$top=20`);
  const items: SharePointItem[] = [];
  for (const site of sites) {
    let drives: Array<{ id: string; name: string }>;
    try {
      drives = await graphPages<{ id: string; name: string }>(`/sites/${site.id}/drives`);
    } catch (err) {
      console.warn(`[m365-sharepoint] skipped site ${site.name || site.id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const drive of drives) {
      type DriveItem = {
        id: string;
        name: string;
        webUrl: string;
        size?: number;
        file?: { mimeType?: string };
        lastModifiedDateTime?: string;
        createdBy?: { user?: { displayName?: string } };
      };
      let children: DriveItem[];
      try {
        children = await graphPages<DriveItem>(`/drives/${drive.id}/root/children?$top=25`);
      } catch (err) {
        console.warn(`[m365-sharepoint] skipped drive ${drive.name || drive.id}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const item of children) {
        if (!item.file) continue;
        const canDownload = isPlainTextDownload(item) && (item.size ?? 0) <= config.M365_SHAREPOINT_MAX_DOWNLOAD_BYTES;
        let contentText: string | null = null;
        if (canDownload) {
          try {
            contentText = await graphDownloadText(
                `/drives/${drive.id}/items/${item.id}/content`,
                config.M365_SHAREPOINT_MAX_DOWNLOAD_BYTES,
              );
          } catch (err) {
            console.warn(`[m365-sharepoint] skipped content for ${item.name || item.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        items.push({
          id: item.id,
          site_id: site.id,
          site_name: site.name,
          drive_id: drive.id,
          drive_name: drive.name,
          name: item.name,
          web_url: item.webUrl,
          size: item.size ?? 0,
          mime_type: item.file.mimeType ?? 'application/octet-stream',
          // v3 freshness contract (Phase 2): empty string when Graph omits
          // lastModifiedDateTime. The downstream connector's slug builder
          // falls back to today's date for chronological ordering only; the
          // emitted upstream_updated_at metadata stays honestly null so the
          // "last refreshed" stamp on rendered pages surfaces "(unknown)"
          // rather than wall-clock-pretending-to-be-record-time.
          last_modified: item.lastModifiedDateTime ?? '',
          modified_by: item.createdBy?.user?.displayName ?? '',
          content_text: contentText,
        });
      }
    }
  }
  return items;
}

export async function fetchTeamsThreads(): Promise<TeamsThread[]> {
  const threads: TeamsThread[] = [];
  const seenMessages = new Set<string>();
  for (const upn of configuredUsers()) {
    try {
      const teams = await graphPages<{ id: string; displayName: string }>(
        `/users/${encodeURIComponent(upn)}/joinedTeams`,
      );
      for (const team of teams) {
        const channels = await graphPages<{ id: string; displayName: string; webUrl: string }>(
          `/teams/${team.id}/channels`,
        );
        for (const channel of channels) {
          type GraphMessage = {
            id: string;
            from?: { user?: { displayName?: string } };
            createdDateTime: string;
            body?: { content?: string; contentType?: string };
            replyToId?: string | null;
          };
          const messages = await graphPages<GraphMessage>(
            `/teams/${team.id}/channels/${channel.id}/messages?$top=20`,
            100,
          );
          for (const msg of messages) {
            const messageKey = `${team.id}:${channel.id}:${msg.id}`;
            if (seenMessages.has(messageKey)) continue;
            seenMessages.add(messageKey);
            const replies = msg.replyToId
              ? []
              : await graphPages<GraphMessage>(
                  `/teams/${team.id}/channels/${channel.id}/messages/${msg.id}/replies?$top=20`,
                  100,
                );
            threads.push({
              id: msg.id,
              user_upn: upn,
              team_id: team.id,
              team_name: team.displayName,
              channel_id: channel.id,
              channel_name: channel.displayName,
              channel_web_url: channel.webUrl,
              author: msg.from?.user?.displayName ?? '',
              created_at: msg.createdDateTime,
              body: msg.body?.content ?? '',
              body_content_type: msg.body?.contentType ?? 'text',
              reply_to_id: msg.replyToId ?? null,
              replies: replies.map((reply) => ({
                id: reply.id,
                author: reply.from?.user?.displayName ?? '',
                created_at: reply.createdDateTime,
                body: reply.body?.content ?? '',
                body_content_type: reply.body?.contentType ?? 'text',
              })),
            });
          }
        }
      }
    } catch (err) {
      console.warn(`[m365-teams] skipped ${upn}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return threads;
}
