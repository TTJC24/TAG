import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { z, ZodError } from "zod";
import type { IdentityProvider } from "@operating-layer/auth";
import type { DatabasePool } from "@operating-layer/db";
import type { ConnectorCredentialEncryptor } from "@operating-layer/connectors";
import {
  createManualIssue,
  authorizeGmailDraft,
  configureGmailDraftConnector,
  createGmailDraftPreview,
  DomainError,
  getCsvBatch,
  getExecutiveQueue,
  getTaskDetail,
  inspectGmailDraftPilotPreflight,
  resolveApproval,
  requestInternalExecution,
  requestInternalExecutionReplay,
  revokeGmailCredential,
  resolveApplicationPrincipal,
  setGmailGlobalKill,
  setGmailDraftPilotClaim,
  storeGmailCredential,
  uploadCsvBatch,
} from "@operating-layer/issue-intake";

export interface ApiDependencies {
  pool: DatabasePool;
  identityProvider: IdentityProvider;
  credentialEncryptor?: ConnectorCredentialEncryptor;
  logger?: boolean;
}

function normalizedHeaders(
  request: FastifyRequest,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(request.headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value[0] : value,
    ]),
  );
}

function headerValue(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function buildApi(
  dependencies: ApiDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: dependencies.logger ?? false,
    genReqId: (request) => {
      const value = request.headers["x-request-id"];
      return (Array.isArray(value) ? value[0] : value) ?? randomUUID();
    },
  });

  await app.register(cors, {
    origin: false,
  });

  app.setErrorHandler((error, request, reply) => {
    const traceId = headerValue(request, "x-trace-id") ?? request.id;
    if (error instanceof DomainError) {
      void reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        traceId,
      });
      return;
    }
    if (error instanceof ZodError) {
      void reply.status(400).send({
        error: "validation_failed",
        message: "The request did not match the required schema",
        issues: error.issues,
        traceId,
      });
      return;
    }
    request.log.error({ err: error, traceId }, "request failed");
    void reply.status(500).send({
      error: "internal_error",
      message: "The request could not be completed",
      traceId,
    });
  });

  async function principalFor(request: FastifyRequest) {
    const identity = await dependencies.identityProvider.authenticate({
      headers: normalizedHeaders(request),
    });
    return resolveApplicationPrincipal(dependencies.pool, identity);
  }

  app.get("/health", async () => {
    await dependencies.pool.query("SELECT 1");
    return {
      status: "healthy",
      externalWritesEnabled: false,
      modelProvider: "deterministic",
      csvUploadMode: "internal",
      gmailDraftConnector: {
        capability: "drafts.create",
        networkExecutionDefault: "disabled",
        defaultState: "disabled",
      },
    };
  });

  app.get("/v1/organizations", async (request) => {
    const principal = await principalFor(request);
    const result = await dependencies.pool.query(
      `SELECT id, name, code
       FROM operating_layer.organizations
       WHERE id = ANY($1::uuid[])
       ORDER BY name`,
      [principal.organizationIds],
    );
    return {
      organizations: result.rows,
      user: {
        id: principal.userId,
        name: principal.name,
        email: principal.email,
      },
    };
  });

  app.post("/v1/issues", async (request, reply) => {
    const principal = await principalFor(request);
    const idempotencyKey = headerValue(request, "idempotency-key");
    if (!idempotencyKey) {
      throw new DomainError(
        400,
        "idempotency_key_required",
        "Idempotency-Key is required",
      );
    }
    const traceId = headerValue(request, "x-trace-id") ?? randomUUID();
    const response = await createManualIssue(dependencies.pool, {
      principal,
      input: request.body as never,
      idempotencyKey,
      context: {
        traceId,
        requestId: request.id,
      },
    });
    return reply.status(response.duplicate ? 200 : 202).send(response);
  });

  app.post("/v1/csv-batches", async (request, reply) => {
    const principal = await principalFor(request);
    const idempotencyKey = headerValue(request, "idempotency-key");
    if (!idempotencyKey) {
      throw new DomainError(
        400,
        "idempotency_key_required",
        "Idempotency-Key is required",
      );
    }
    const traceId = headerValue(request, "x-trace-id") ?? randomUUID();
    const response = await uploadCsvBatch(dependencies.pool, {
      principal,
      input: request.body as never,
      idempotencyKey,
      context: {
        traceId,
        requestId: request.id,
      },
    });
    return reply.status(response.duplicate ? 200 : 202).send(response);
  });

  app.get<{
    Params: { batchId: string };
    Querystring: { organizationId?: string };
  }>("/v1/csv-batches/:batchId", async (request) => {
    const principal = await principalFor(request);
    const organizationId = request.query.organizationId;
    if (!organizationId) {
      throw new DomainError(
        400,
        "organization_required",
        "An explicit organizationId is required",
      );
    }
    return getCsvBatch(
      dependencies.pool,
      principal,
      z.string().uuid().parse(organizationId),
      z.string().uuid().parse(request.params.batchId),
    );
  });

  app.post<{
    Params: { approvalId: string };
  }>("/v1/approvals/:approvalId/resolution", async (request, reply) => {
    const principal = await principalFor(request);
    const idempotencyKey = headerValue(request, "idempotency-key");
    if (!idempotencyKey) {
      throw new DomainError(
        400,
        "idempotency_key_required",
        "Idempotency-Key is required",
      );
    }
    const traceId = headerValue(request, "x-trace-id") ?? randomUUID();
    const response = await resolveApproval(dependencies.pool, {
      principal,
      approvalId: z.string().uuid().parse(request.params.approvalId),
      input: request.body as never,
      idempotencyKey,
      context: {
        traceId,
        requestId: request.id,
      },
    });
    return reply.status(response.duplicate ? 200 : 202).send(response);
  });

  app.post<{
    Params: { approvalId: string };
  }>("/v1/approvals/:approvalId/executions", async (request, reply) => {
    const principal = await principalFor(request);
    const idempotencyKey = headerValue(request, "idempotency-key");
    if (!idempotencyKey) {
      throw new DomainError(
        400,
        "idempotency_key_required",
        "Idempotency-Key is required",
      );
    }
    const traceId = headerValue(request, "x-trace-id") ?? randomUUID();
    const response = await requestInternalExecution(dependencies.pool, {
      principal,
      approvalId: z.string().uuid().parse(request.params.approvalId),
      input: request.body as never,
      idempotencyKey,
      context: {
        traceId,
        requestId: request.id,
      },
    });
    return reply.status(response.duplicate ? 200 : 202).send(response);
  });

  app.post<{
    Params: { approvalId: string };
  }>("/v1/approvals/:approvalId/executions/replay", async (request, reply) => {
    const principal = await principalFor(request);
    const idempotencyKey = headerValue(request, "idempotency-key");
    if (!idempotencyKey) {
      throw new DomainError(
        400,
        "idempotency_key_required",
        "Idempotency-Key is required",
      );
    }
    const traceId = headerValue(request, "x-trace-id") ?? randomUUID();
    const response = await requestInternalExecutionReplay(dependencies.pool, {
      principal,
      approvalId: z.string().uuid().parse(request.params.approvalId),
      input: request.body as never,
      idempotencyKey,
      context: {
        traceId,
        requestId: request.id,
      },
    });
    return reply.status(response.duplicate ? 200 : 202).send(response);
  });

  app.post("/v1/connectors/gmail-draft/config", async (request, reply) => {
    const principal = await principalFor(request);
    const idempotencyKey = headerValue(request, "idempotency-key");
    if (!idempotencyKey) {
      throw new DomainError(
        400,
        "idempotency_key_required",
        "Idempotency-Key is required",
      );
    }
    const traceId = headerValue(request, "x-trace-id") ?? randomUUID();
    const response = await configureGmailDraftConnector(dependencies.pool, {
      principal,
      input: request.body as never,
      idempotencyKey,
      context: { traceId, requestId: request.id },
    });
    return reply.status(response.duplicate ? 200 : 202).send(response);
  });

  app.post("/v1/connectors/gmail-draft/credentials", async (request, reply) => {
    if (!dependencies.credentialEncryptor) {
      throw new DomainError(
        503,
        "credential_encryption_unavailable",
        "Connector credential encryption is unavailable",
      );
    }
    const principal = await principalFor(request);
    const idempotencyKey = headerValue(request, "idempotency-key");
    if (!idempotencyKey) {
      throw new DomainError(
        400,
        "idempotency_key_required",
        "Idempotency-Key is required",
      );
    }
    const traceId = headerValue(request, "x-trace-id") ?? randomUUID();
    const response = await storeGmailCredential(
      dependencies.pool,
      dependencies.credentialEncryptor,
      {
        principal,
        input: request.body as never,
        idempotencyKey,
        context: { traceId, requestId: request.id },
      },
    );
    return reply.status(response.duplicate ? 200 : 202).send(response);
  });

  app.post(
    "/v1/connectors/gmail-draft/credentials/revoke",
    async (request, reply) => {
      const principal = await principalFor(request);
      const idempotencyKey = headerValue(request, "idempotency-key");
      if (!idempotencyKey) {
        throw new DomainError(
          400,
          "idempotency_key_required",
          "Idempotency-Key is required",
        );
      }
      const traceId = headerValue(request, "x-trace-id") ?? randomUUID();
      const response = await revokeGmailCredential(dependencies.pool, {
        principal,
        input: request.body as never,
        idempotencyKey,
        context: { traceId, requestId: request.id },
      });
      return reply.status(response.duplicate ? 200 : 202).send(response);
    },
  );

  app.post("/v1/connectors/gmail-draft/global-kill", async (request, reply) => {
    const principal = await principalFor(request);
    const traceId = headerValue(request, "x-trace-id") ?? randomUUID();
    const response = await setGmailGlobalKill(dependencies.pool, {
      principal,
      input: request.body,
      context: { traceId, requestId: request.id },
    });
    return reply.status(202).send(response);
  });

  app.post("/v1/connectors/gmail-draft/pilot/claim", async (request, reply) => {
    const principal = await principalFor(request);
    const idempotencyKey = headerValue(request, "idempotency-key");
    if (!idempotencyKey) {
      throw new DomainError(
        400,
        "idempotency_key_required",
        "Idempotency-Key is required",
      );
    }
    const traceId = headerValue(request, "x-trace-id") ?? randomUUID();
    const response = await setGmailDraftPilotClaim(dependencies.pool, {
      principal,
      input: request.body as never,
      idempotencyKey,
      context: { traceId, requestId: request.id },
    });
    return reply.status(response.duplicate ? 200 : 202).send(response);
  });

  app.post(
    "/v1/connectors/gmail-draft/pilot/preflight",
    async (request, reply) => {
      const principal = await principalFor(request);
      const traceId = headerValue(request, "x-trace-id") ?? randomUUID();
      const response = await inspectGmailDraftPilotPreflight(
        dependencies.pool,
        {
          principal,
          input: request.body as never,
          context: { traceId, requestId: request.id },
        },
      );
      return reply.status(200).send(response);
    },
  );

  app.post<{
    Params: { approvalId: string };
  }>(
    "/v1/approvals/:approvalId/gmail-draft-preview",
    async (request, reply) => {
      const principal = await principalFor(request);
      const idempotencyKey = headerValue(request, "idempotency-key");
      if (!idempotencyKey) {
        throw new DomainError(
          400,
          "idempotency_key_required",
          "Idempotency-Key is required",
        );
      }
      const traceId = headerValue(request, "x-trace-id") ?? randomUUID();
      const response = await createGmailDraftPreview(dependencies.pool, {
        principal,
        approvalId: z.string().uuid().parse(request.params.approvalId),
        input: request.body as never,
        idempotencyKey,
        context: { traceId, requestId: request.id },
      });
      return reply.status(response.duplicate ? 200 : 202).send(response);
    },
  );

  app.post<{
    Params: { previewId: string };
  }>(
    "/v1/gmail-draft-previews/:previewId/authorization",
    async (request, reply) => {
      const principal = await principalFor(request);
      const idempotencyKey = headerValue(request, "idempotency-key");
      if (!idempotencyKey) {
        throw new DomainError(
          400,
          "idempotency_key_required",
          "Idempotency-Key is required",
        );
      }
      const traceId = headerValue(request, "x-trace-id") ?? randomUUID();
      const response = await authorizeGmailDraft(dependencies.pool, {
        principal,
        previewId: z.string().uuid().parse(request.params.previewId),
        input: request.body as never,
        idempotencyKey,
        context: { traceId, requestId: request.id },
      });
      return reply.status(response.duplicate ? 200 : 202).send(response);
    },
  );

  app.get<{
    Querystring: { organizationId?: string };
  }>("/v1/executive-queue", async (request) => {
    const principal = await principalFor(request);
    const organizationId = request.query.organizationId;
    if (!organizationId) {
      throw new DomainError(
        400,
        "organization_required",
        "An explicit organizationId is required",
      );
    }
    return getExecutiveQueue(dependencies.pool, principal, organizationId);
  });

  app.get<{
    Params: { taskId: string };
    Querystring: { organizationId?: string };
  }>("/v1/tasks/:taskId", async (request) => {
    const principal = await principalFor(request);
    const organizationId = request.query.organizationId;
    if (!organizationId) {
      throw new DomainError(
        400,
        "organization_required",
        "An explicit organizationId is required",
      );
    }
    return getTaskDetail(
      dependencies.pool,
      principal,
      organizationId,
      request.params.taskId,
    );
  });

  return app;
}
