import { createRemoteJWKSet, jwtVerify } from "jose";

export type PrincipalType = "user" | "service";

export interface Principal {
  type: PrincipalType;
  id: string;
  active: boolean;
  organizationIds: readonly string[];
  permissions: readonly string[];
  sessionId?: string;
}

export interface AuthorizationRequest {
  principal: Principal;
  organizationId: string;
  permission: string;
  resourceId?: string;
  riskLevel?: number;
}

export interface AuthorizationDecision {
  allowed: boolean;
  reasonCode: string;
  policyVersion: string;
  requiresApproval: boolean;
}

export interface Authorizer {
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}

export interface IdentityRequest {
  headers: Readonly<Record<string, string | undefined>>;
}

export interface ExternalIdentity {
  issuer: string;
  subject: string;
  email: string;
  displayName?: string;
}

export interface IdentityProvider {
  readonly kind: string;
  authenticate(request: IdentityRequest): Promise<ExternalIdentity>;
}

export class AuthenticationError extends Error {
  readonly statusCode = 401;
}

export class DevelopmentHeaderIdentityProvider implements IdentityProvider {
  readonly kind = "development-header";

  constructor(private readonly headerName = "x-dev-user-email") {}

  async authenticate(request: IdentityRequest): Promise<ExternalIdentity> {
    const email = request.headers[this.headerName]?.trim().toLowerCase();
    if (!email) {
      throw new AuthenticationError(
        `Missing development identity header ${this.headerName}`,
      );
    }

    return {
      issuer: "local",
      subject: `email:${email}`,
      email,
    };
  }
}

/**
 * Trusts the identity header Cloudflare Access injects after its own login
 * (the pattern the company-brain droplet already uses). SAFE ONLY when the
 * origin is reachable exclusively through the Cloudflare tunnel — anyone who
 * can reach the origin directly could forge the header, so the deployment
 * must not publish the API/web ports. Verifying the Cf-Access-Jwt-Assertion
 * signature is the documented hardening follow-up.
 */
export class CloudflareAccessIdentityProvider implements IdentityProvider {
  readonly kind = "cloudflare_access";

  async authenticate(request: IdentityRequest): Promise<ExternalIdentity> {
    const email = request.headers["cf-access-authenticated-user-email"];
    if (!email || email.trim().length === 0) {
      throw new AuthenticationError(
        "Cloudflare Access identity header is missing",
      );
    }
    return {
      issuer: "cloudflare-access",
      subject: email.trim().toLowerCase(),
      email: email.trim().toLowerCase(),
    };
  }
}

export interface GoogleWorkspaceOidcOptions {
  issuer: string;
  audience: string;
  hostedDomain: string;
  jwksUri?: string;
}

export class GoogleWorkspaceOidcProvider implements IdentityProvider {
  readonly kind = "google-workspace-oidc";
  private readonly jwks;

  constructor(private readonly options: GoogleWorkspaceOidcOptions) {
    this.jwks = createRemoteJWKSet(
      new URL(options.jwksUri ?? "https://www.googleapis.com/oauth2/v3/certs"),
    );
  }

  async authenticate(request: IdentityRequest): Promise<ExternalIdentity> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      throw new AuthenticationError("Missing OIDC bearer token");
    }

    try {
      const token = authorization.slice("Bearer ".length);
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.options.issuer,
        audience: this.options.audience,
      });

      if (
        typeof payload.sub !== "string" ||
        typeof payload.email !== "string" ||
        payload.email_verified !== true ||
        payload.hd !== this.options.hostedDomain
      ) {
        throw new AuthenticationError(
          "OIDC identity is not an approved Google Workspace user",
        );
      }

      return {
        issuer: this.options.issuer,
        subject: payload.sub,
        email: payload.email.toLowerCase(),
        ...(typeof payload.name === "string"
          ? { displayName: payload.name }
          : {}),
      };
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw error;
      }
      throw new AuthenticationError("OIDC token validation failed");
    }
  }
}
