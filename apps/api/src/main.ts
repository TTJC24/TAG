import {
  CloudflareAccessIdentityProvider,
  DevelopmentHeaderIdentityProvider,
  GoogleWorkspaceOidcProvider,
  type IdentityProvider,
} from "@operating-layer/auth";
import {
  assertSafeRuntimeDatabaseIdentity,
  createDatabasePool,
} from "@operating-layer/db";
import { RsaEnvelopeCredentialEncryptor } from "@operating-layer/connectors";
import { buildApi } from "./server.js";

function identityProviderFromEnvironment(): IdentityProvider {
  if (process.env.AUTH_MODE === "cloudflare_access") {
    // Origin must be reachable only through the Cloudflare tunnel; see
    // docs/deploy-runbook.md before enabling.
    return new CloudflareAccessIdentityProvider();
  }
  if (process.env.AUTH_MODE === "oidc") {
    const issuer = process.env.OIDC_ISSUER;
    const audience = process.env.OIDC_AUDIENCE;
    const hostedDomain = process.env.GOOGLE_WORKSPACE_DOMAIN;
    if (!issuer || !audience || !hostedDomain) {
      throw new Error(
        "OIDC_ISSUER, OIDC_AUDIENCE, and GOOGLE_WORKSPACE_DOMAIN are required",
      );
    }
    return new GoogleWorkspaceOidcProvider({
      issuer,
      audience,
      hostedDomain,
      ...(process.env.OIDC_JWKS_URI
        ? { jwksUri: process.env.OIDC_JWKS_URI }
        : {}),
    });
  }
  return new DevelopmentHeaderIdentityProvider();
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const pool = createDatabasePool(databaseUrl);
try {
  await assertSafeRuntimeDatabaseIdentity(pool);
} catch (error) {
  await pool.end();
  throw error;
}
const credentialPublicKey = process.env.CONNECTOR_CREDENTIAL_PUBLIC_KEY_DER_B64;
if (!credentialPublicKey) {
  await pool.end();
  throw new Error("CONNECTOR_CREDENTIAL_PUBLIC_KEY_DER_B64 is required");
}
const app = await buildApi({
  pool,
  identityProvider: identityProviderFromEnvironment(),
  credentialEncryptor: new RsaEnvelopeCredentialEncryptor(credentialPublicKey),
  logger: true,
});

const port = Number(process.env.API_PORT ?? 3001);
await app.listen({ host: "0.0.0.0", port });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
