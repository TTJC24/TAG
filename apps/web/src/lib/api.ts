import { identityHeaders } from "./identity";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:3001";

export const defaultOrganizationId =
  process.env.DEFAULT_ORGANIZATION_ID ?? "10000000-0000-4000-8000-000000000001";

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
    throw new Error(
      detail?.message ?? `API request failed (${response.status})`,
    );
  }
  return (await response.json()) as T;
}
