import { defaultOrganizationId, operatingLayerApi } from "../../../lib/api";
import { CsvBatchUploadForm } from "./upload-form";

export const dynamic = "force-dynamic";

interface Organization {
  id: string;
  name: string;
  code: string;
}

export default async function NewCsvBatchPage({
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
          <p className="eyebrow">Controlled batch intake</p>
          <h1>Upload operational issues</h1>
          <p className="lede">
            Each valid CSV row enters the same governed issue pipeline. Rejected
            rows remain visible with exact validation reasons.
          </p>
        </div>
      </section>
      <CsvBatchUploadForm
        initialOrganizationId={initialOrganizationId}
        organizations={response.organizations}
      />
    </div>
  );
}
