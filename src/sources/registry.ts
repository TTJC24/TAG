import type { ConnectorSpec } from './types.ts';
import { m365CalendarConnector } from './m365-calendar.ts';
import { m365MailConnector } from './m365-mail.ts';
import { m365SharePointConnector } from './m365-sharepoint.ts';
import { m365TeamsConnector } from './m365-teams.ts';
import { acumaticaConnector, createAcumaticaConnector } from './acumatica.ts';
import { createPipedriveConnector, pipedriveConnector } from './pipedrive.ts';
import { supermemoryConnectors } from './supermemory.ts';

export const connectors: Record<string, ConnectorSpec> = {
  [m365CalendarConnector.id]: m365CalendarConnector,
  [m365MailConnector.id]: m365MailConnector,
  [m365SharePointConnector.id]: m365SharePointConnector,
  [m365TeamsConnector.id]: m365TeamsConnector,
  [acumaticaConnector.id]: acumaticaConnector,
  'acumatica-fs': createAcumaticaConnector('acumatica-fs', 'Acumatica ERP - FS', 'FS'),
  'acumatica-blcs': createAcumaticaConnector('acumatica-blcs', 'Acumatica ERP - BLCS', 'BLCS'),
  'acumatica-usa': createAcumaticaConnector('acumatica-usa', 'Acumatica ERP - USA', 'USA'),
  [pipedriveConnector.id]: pipedriveConnector,
  'pipedrive-fs': createPipedriveConnector('pipedrive-fs', 'Pipedrive CRM - FS', 'PIPEDRIVE_API_TOKEN_FS', 'PIPEDRIVE_COMPANY_DOMAIN_FS'),
  'pipedrive-blcs-usa': createPipedriveConnector('pipedrive-blcs-usa', 'Pipedrive CRM - BLCS/USA', 'PIPEDRIVE_API_TOKEN_BLCS_USA', 'PIPEDRIVE_COMPANY_DOMAIN_BLCS_USA'),
  ...Object.fromEntries(supermemoryConnectors.map((c) => [c.id, c])),
};

export function listConnectorIds(): string[] {
  return Object.keys(connectors);
}

export function getConnector(id: string): ConnectorSpec {
  const c = connectors[id];
  if (!c) throw new Error(`Unknown connector: ${id}. Known: ${listConnectorIds().join(', ')}`);
  return c;
}
