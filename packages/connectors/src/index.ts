export interface ConnectorContext {
  organizationId: string;
  sourceSystemId: string;
  traceId: string;
  idempotencyKey: string;
  secretReference: string;
}

export interface ConnectorHealth {
  status: "healthy" | "degraded" | "unavailable" | "unconfigured";
  checkedAt: string;
  latencyMs?: number;
  safeMessage?: string;
}

export interface SupportedObject {
  recordType: string;
  incrementalSync: boolean;
  canonicalUrl: boolean;
}

export interface FetchPageRequest {
  recordType: string;
  cursor?: string;
  changedAfter?: string;
  limit: number;
}

export interface ExternalRecord {
  externalId: string;
  recordType: string;
  sourceUpdatedAt?: string;
  observedAt: string;
  canonicalUrl?: string;
  payload: unknown;
}

export interface FetchPage {
  records: readonly ExternalRecord[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface NormalizedRecord {
  externalId: string;
  recordType: string;
  organizationId: string;
  title?: string;
  summary?: string;
  canonicalUrl?: string;
  sourceUpdatedAt?: string;
  observedAt: string;
  rawContentHash: string;
  normalized: Readonly<Record<string, unknown>>;
}

export interface SyncResult {
  read: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  nextCursor?: string;
}

export interface ReadConnector {
  readonly connectorType: string;
  connect(context: ConnectorContext): Promise<void>;
  healthCheck(context: ConnectorContext): Promise<ConnectorHealth>;
  listSupportedObjects(): Promise<readonly SupportedObject[]>;
  fetchRecords(
    context: ConnectorContext,
    request: FetchPageRequest,
  ): Promise<FetchPage>;
  fetchRecord(
    context: ConnectorContext,
    recordType: string,
    externalId: string,
  ): Promise<ExternalRecord | null>;
  normalizeRecord(
    context: ConnectorContext,
    record: ExternalRecord,
  ): Promise<NormalizedRecord>;
  getRecordUrl(
    context: ConnectorContext,
    recordType: string,
    externalId: string,
  ): Promise<string | null>;
  getLastSync(context: ConnectorContext): Promise<string | null>;
  syncIncremental(
    context: ConnectorContext,
    request: FetchPageRequest,
  ): Promise<SyncResult>;
}

export interface ActionPreview {
  actionType: string;
  targetExternalId: string;
  normalizedPayload: Readonly<Record<string, unknown>>;
  payloadHash: string;
  warnings: readonly string[];
}

/**
 * Future capability contract only. No Phase 1 adapter may implement or register
 * this interface.
 */
export interface ControlledWriteConnector {
  validateAction(
    context: ConnectorContext,
    action: unknown,
  ): Promise<{ valid: boolean; errors: readonly string[] }>;
  previewAction(
    context: ConnectorContext,
    action: unknown,
  ): Promise<ActionPreview>;
  requestApproval(
    context: ConnectorContext,
    preview: ActionPreview,
  ): Promise<{ approvalId: string }>;
  executeAction(
    context: ConnectorContext,
    approvalId: string,
    preview: ActionPreview,
  ): Promise<{ executionReference: string }>;
  verifyAction(
    context: ConnectorContext,
    executionReference: string,
  ): Promise<{ verified: boolean; observedHash?: string }>;
  rollbackAction(
    context: ConnectorContext,
    executionReference: string,
  ): Promise<{ rolledBack: boolean; rollbackReference?: string }>;
}
