import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto";

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

export const GMAIL_COMPOSE_SCOPE =
  "https://www.googleapis.com/auth/gmail.compose" as const;
export const GMAIL_CREDENTIAL_SCOPE_ALLOWLIST = [GMAIL_COMPOSE_SCOPE] as const;

export interface EncryptedCredentialEnvelope {
  algorithm: "rsa-oaep-sha256+aes-256-gcm-v1";
  ciphertext: string;
  nonce: string;
  authenticationTag: string;
  wrappedDataKey: string;
  fingerprint: string;
}

export interface ConnectorCredentialEncryptor {
  encrypt(
    plaintext: string,
    context: { organizationId: string; credentialVersionId: string },
  ): EncryptedCredentialEnvelope;
}

export interface ConnectorCredentialDecryptor {
  decrypt(
    envelope: EncryptedCredentialEnvelope,
    context: { organizationId: string; credentialVersionId: string },
  ): string;
}

export function assertExactGmailCredentialScopes(
  scopes: readonly string[],
): asserts scopes is readonly [typeof GMAIL_COMPOSE_SCOPE] {
  if (scopes.length !== 1 || scopes[0] !== GMAIL_COMPOSE_SCOPE) {
    throw new Error(`Gmail credentials require exactly ${GMAIL_COMPOSE_SCOPE}`);
  }
}

export function credentialFingerprint(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function redactSensitiveText(
  value: string,
  secrets: readonly string[],
): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce(
      (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
      value,
    );
}

function aad(context: {
  organizationId: string;
  credentialVersionId: string;
}): Buffer {
  return Buffer.from(
    `gmail-draft:${context.organizationId}:${context.credentialVersionId}`,
    "utf8",
  );
}

export class RsaEnvelopeCredentialEncryptor implements ConnectorCredentialEncryptor {
  private readonly publicKey: KeyObject;

  constructor(publicKeyDerBase64: string) {
    if (!publicKeyDerBase64) {
      throw new Error("Connector credential public encryption key is required");
    }
    this.publicKey = createPublicKey({
      key: Buffer.from(publicKeyDerBase64, "base64"),
      format: "der",
      type: "spki",
    });
  }

  encrypt(
    plaintext: string,
    context: { organizationId: string; credentialVersionId: string },
  ): EncryptedCredentialEnvelope {
    if (!plaintext.trim()) {
      throw new Error("Connector credential cannot be empty");
    }
    const dataKey = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
    cipher.setAAD(aad(context));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const authenticationTag = cipher.getAuthTag();
    const wrappedDataKey = publicEncrypt(
      {
        key: this.publicKey,
        oaepHash: "sha256",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      dataKey,
    );
    dataKey.fill(0);
    return {
      algorithm: "rsa-oaep-sha256+aes-256-gcm-v1",
      ciphertext: ciphertext.toString("base64"),
      nonce: nonce.toString("base64"),
      authenticationTag: authenticationTag.toString("base64"),
      wrappedDataKey: wrappedDataKey.toString("base64"),
      fingerprint: credentialFingerprint(plaintext),
    };
  }
}

export class RsaEnvelopeCredentialDecryptor implements ConnectorCredentialDecryptor {
  private readonly privateKey: KeyObject;

  constructor(privateKeyDerBase64: string) {
    if (!privateKeyDerBase64) {
      throw new Error(
        "Connector credential private decryption key is required",
      );
    }
    this.privateKey = createPrivateKey({
      key: Buffer.from(privateKeyDerBase64, "base64"),
      format: "der",
      type: "pkcs8",
    });
  }

  decrypt(
    envelope: EncryptedCredentialEnvelope,
    context: { organizationId: string; credentialVersionId: string },
  ): string {
    if (envelope.algorithm !== "rsa-oaep-sha256+aes-256-gcm-v1") {
      throw new Error("Unsupported connector credential envelope");
    }
    const dataKey = privateDecrypt(
      {
        key: this.privateKey,
        oaepHash: "sha256",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(envelope.wrappedDataKey, "base64"),
    );
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        dataKey,
        Buffer.from(envelope.nonce, "base64"),
      );
      decipher.setAAD(aad(context));
      decipher.setAuthTag(Buffer.from(envelope.authenticationTag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } finally {
      dataKey.fill(0);
    }
  }
}

export class EphemeralConnectorCredential {
  #value: string | null;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    if (this.#value === null) {
      throw new Error("Connector credential has been disposed");
    }
    return this.#value;
  }

  dispose(): void {
    this.#value = null;
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }
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

export * from "./company-brain.js";
export * from "./pipedrive.js";
