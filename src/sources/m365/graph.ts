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
  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });
  if (!result?.accessToken) throw new Error('Failed to acquire M365 token');
  cachedToken = {
    token: result.accessToken,
    expiresAt: result.expiresOn?.getTime() ?? Date.now() + 30 * 60_000,
  };
  return cachedToken.token;
}

async function graphFetch<T>(path: string): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph ${path} ${res.status}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

async function graphPages<TItem>(path: string, max = 500): Promise<TItem[]> {
  const items: TItem[] = [];
  let next: string | undefined = path;
  while (next && items.length < max) {
    const url: string = next.startsWith('http') ? next.replace(GRAPH_BASE, '') : next;
    const page: { value: TItem[]; '@odata.nextLink'?: string } =
      await graphFetch(url);
    items.push(...page.value);
    next = page['@odata.nextLink'];
  }
  return items.slice(0, max);
}

export async function fetchCalendarEvents(): Promise<CalendarEvent[]> {
  const upn = requireEnv('M365_USER_PRINCIPAL_NAME');
  const path = `/users/${encodeURIComponent(upn)}/calendar/events?$top=50&$orderby=start/dateTime%20desc`;
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
  const items = await graphPages<GraphEvent>(path);
  return items.map((g) => ({
    id: g.id,
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
  }));
}

export async function fetchMailMessages(): Promise<MailMessage[]> {
  const upn = requireEnv('M365_USER_PRINCIPAL_NAME');
  const path = `/users/${encodeURIComponent(upn)}/messages?$top=50&$orderby=receivedDateTime%20desc&$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,conversationId,webLink`;
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
  const items = await graphPages<GraphMessage>(path);
  return items.map((m) => ({
    id: m.id,
    subject: m.subject,
    from: m.from?.emailAddress?.address ?? m.from?.emailAddress?.name ?? '',
    to: m.toRecipients?.map((r) => r.emailAddress?.address ?? '').filter(Boolean) ?? [],
    cc: m.ccRecipients?.map((r) => r.emailAddress?.address ?? '').filter(Boolean) ?? [],
    received_at: m.receivedDateTime,
    body_preview: m.bodyPreview ?? null,
    conversation_id: m.conversationId ?? null,
    web_link: m.webLink ?? null,
  }));
}

export async function fetchSharePointItems(): Promise<SharePointItem[]> {
  if (!config.M365_TENANT_ID) throw new Error('Missing M365 creds');
  const sites = await graphPages<{ id: string; name: string; webUrl: string }>(`/sites?search=*&$top=20`);
  const items: SharePointItem[] = [];
  for (const site of sites) {
    const drives = await graphPages<{ id: string; name: string }>(`/sites/${site.id}/drives`);
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
      const children = await graphPages<DriveItem>(`/drives/${drive.id}/root/children?$top=25`);
      for (const item of children) {
        if (!item.file) continue;
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
          last_modified: item.lastModifiedDateTime ?? new Date().toISOString(),
          modified_by: item.createdBy?.user?.displayName ?? '',
        });
      }
    }
  }
  return items;
}

export async function fetchTeamsThreads(): Promise<TeamsThread[]> {
  const teams = await graphPages<{ id: string; displayName: string }>(`/me/joinedTeams`);
  const threads: TeamsThread[] = [];
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
        threads.push({
          id: msg.id,
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
        });
      }
    }
  }
  return threads;
}
