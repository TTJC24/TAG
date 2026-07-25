import { defaultOrganizationId, operatingLayerApi } from "../../../lib/api";
import { IssueForm } from "./issue-form";

export const dynamic = "force-dynamic";

interface Organization {
  id: string;
  name: string;
  code: string;
}

export default async function NewIssuePage({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string }>;
}) {
  const params = await searchParams;
  const response = await operatingLayerApi<{
    organizations: Organization[];
  }>("/v1/organizations");
  const initialOrganizationId =
    params.organizationId ??
    response.organizations[0]?.id ??
    defaultOrganizationId;

  return (
    <div className="narrowPage">
      <section className="pageHeading">
        <div>
          <p className="eyebrow">Controlled intake</p>
          <h1>Capture an operational issue</h1>
          <p className="lede">
            The submission becomes a source-linked task, runs through
            deterministic classification and recommendation, and records every
            decision.
          </p>
        </div>
      </section>
      <IssueForm
        initialOrganizationId={initialOrganizationId}
        organizations={response.organizations}
      />
    </div>
  );
}
