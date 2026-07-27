import { identityHeaders } from "./identity";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:3001";

export const defaultOrganizationId =
  process.env.DEFAULT_ORGANIZATION_ID ?? "10000000-0000-4000-8000-000000000001";

/**
 * An API failure that keeps its status code, so a caller can tell an expected
 * "not found" apart from the API being broken.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function operatingLayerApi<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(await identityHeaders()),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new ApiError(
      detail?.message ?? `API request failed (${response.status})`,
      response.status,
    );
  }
  return (await response.json()) as T;
}
