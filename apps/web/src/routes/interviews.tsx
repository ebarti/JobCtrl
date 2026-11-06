import { createFileRoute } from "@tanstack/react-router";

import { CompanyBriefingForJob } from "../contexts/companies/index.js";
import { useMountedFeatures } from "../contexts/runtime/index.js";
import { InterviewsView } from "../views/interviews/InterviewsView.js";
import { interviewsSearchSchema } from "./-interviews.search.js";

export const Route = createFileRoute("/interviews")({
  validateSearch: (search) => interviewsSearchSchema.parse(search),
  component: InterviewsComposition,
});

function InterviewsComposition() {
  const features = useMountedFeatures();
  return <InterviewsView {...(features.has("companies")
    ? { companyBriefing: (jobId: string) => <CompanyBriefingForJob jobId={jobId} /> } : {})} />;
}
