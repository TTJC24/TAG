import {
  createFetchOperatorHttpClient,
  mailCredentialFingerprint,
  MailDraftPilotOperator,
} from "./mail-draft-pilot-client.js";

type Command = "enable" | "preflight" | "disable";

interface ParsedArguments {
  command: Command;
  flags: Map<string, string | true>;
}

function usage(): string {
  return [
    "Usage:",
    "  pnpm mail-draft:pilot enable --organization-id <uuid> --organization-code <code> --recipient <email> --reason <text> --confirm-one-org --confirm-drafts-create-only [--operation-id <id>]",
    "  pnpm mail-draft:pilot preflight --organization-id <uuid> --organization-code <code> [--recipient <email>]",
    "  pnpm mail-draft:pilot disable --organization-id <uuid> --organization-code <code> --reason <text> [--operation-id <id>]",
    "",
    "Secrets are read only from environment variables:",
    "  OPERATING_LAYER_OPERATOR_BEARER_TOKEN",
    "  MAIL_DRAFT_OAUTH_ACCESS_TOKEN (enable; optional for fingerprint check during preflight)",
    "",
    "API_BASE_URL defaults to http://localhost:3001.",
    "Development auth requires --allow-development-auth and DEV_USER_EMAIL.",
  ].join("\n");
}

function parseArguments(argv: string[]): ParsedArguments {
  const command = argv[0];
  if (!["enable", "preflight", "disable"].includes(command ?? "")) {
    throw new Error(usage());
  }
  const flags = new Map<string, string | true>();
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${name ?? ""}\n\n${usage()}`);
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(name, true);
      continue;
    }
    flags.set(name, next);
    index += 1;
  }
  return { command: command as Command, flags };
}

function requiredFlag(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required ${name}\n\n${usage()}`);
  }
  return value;
}

function optionalFlag(
  flags: Map<string, string | true>,
  name: string,
): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const organizationId = requiredFlag(parsed.flags, "--organization-id");
  const organizationCode = requiredFlag(parsed.flags, "--organization-code");
  const bearerToken = process.env.OPERATING_LAYER_OPERATOR_BEARER_TOKEN;
  const developmentUserEmail = process.env.DEV_USER_EMAIL;
  const allowDevelopmentAuth = parsed.flags.has("--allow-development-auth");
  if (!bearerToken && (!developmentUserEmail || !allowDevelopmentAuth)) {
    throw new Error(
      "Set OPERATING_LAYER_OPERATOR_BEARER_TOKEN. Local development may instead set DEV_USER_EMAIL and pass --allow-development-auth.",
    );
  }
  const request = createFetchOperatorHttpClient(
    bearerToken
      ? {
          apiBaseUrl: process.env.API_BASE_URL ?? "http://localhost:3001",
          bearerToken,
        }
      : {
          apiBaseUrl: process.env.API_BASE_URL ?? "http://localhost:3001",
          developmentUserEmail: developmentUserEmail!,
        },
  );
  const operator = new MailDraftPilotOperator(request);
  const target = { organizationId, organizationCode };
  const operationId = optionalFlag(parsed.flags, "--operation-id");

  if (parsed.command === "enable") {
    if (
      !parsed.flags.has("--confirm-one-org") ||
      !parsed.flags.has("--confirm-drafts-create-only")
    ) {
      throw new Error(
        "Enable requires --confirm-one-org and --confirm-drafts-create-only",
      );
    }
    const accessToken = process.env.MAIL_DRAFT_OAUTH_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error(
        "MAIL_DRAFT_OAUTH_ACCESS_TOKEN is required and must not be passed as a command-line argument",
      );
    }
    const result = await operator.enable({
      target,
      recipient: requiredFlag(parsed.flags, "--recipient"),
      accessToken,
      reason: requiredFlag(parsed.flags, "--reason"),
      ...(operationId ? { operationId } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (parsed.command === "disable") {
    const result = await operator.disable({
      target,
      reason: requiredFlag(parsed.flags, "--reason"),
      ...(operationId ? { operationId } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const accessToken = process.env.MAIL_DRAFT_OAUTH_ACCESS_TOKEN;
  const expectedRecipient = optionalFlag(parsed.flags, "--recipient");
  const result = await operator.preflight({
    target,
    ...(expectedRecipient ? { expectedRecipient } : {}),
    ...(accessToken
      ? {
          expectedCredentialFingerprint: mailCredentialFingerprint(accessToken),
        }
      : {}),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.readyForLiveDraft && !result.disabledByDefault) {
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown operator error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
