import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { z, ZodError } from "zod";
import type { IdentityProvider } from "@operating-layer/auth";
import type { DatabasePool } from "@operating-layer/db";
import {
  createManualIssue,
  DomainError,
  getExecutiveQueue,
  getTaskDetail,
  resolveApproval,
  requestInternalExecution,
  resolveApplicationPrincipal,
} from "@operating-layer/issue-intake";

export interface ApiDependencies {
  pool: DatabasePool;
  identityProvider: IdentityProvider;
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
