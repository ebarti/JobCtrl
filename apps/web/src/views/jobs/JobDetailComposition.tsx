import type { ReactNode } from "react";

import { ApplicationPanel, JobOutcomePanel, ScreeningAnswerLibrary } from "../../contexts/apply/index.js";
import { CompanyBriefingForJob } from "../../contexts/companies/index.js";
import { AffectedMatchesPanel } from "../../contexts/fit/index.js";
import { CompensationPanel, OfferCompensationComparison } from "../../contexts/compensation/index.js";
import { OfferPanel } from "../../contexts/offers/index.js";
import { JobContactsPanel, OfferCommunication } from "../../contexts/outreach/index.js";
import { InterviewPrepForJob } from "../../contexts/interviews/index.js";
import { JobActions, type PreparationResumeMode } from "../../contexts/pipeline/index.js";
import { useMountedFeatures } from "../../contexts/runtime/index.js";
import { useApplicationSettings } from "../../contexts/settings/index.js";
import { JobDetailDrawer, type JobWorkspaceTab } from "./JobDetailDrawer.js";

/** Shell-owned contributions keep the core job workspace independently usable. */
export function JobDetailComposition({ jobId, onClose, activeTab, onTabChange, returnLabel, initialResumeMode = null, onResumeModeChange, renderProfileSetup }: { readonly jobId: string; readonly onClose: () => void; readonly activeTab?: JobWorkspaceTab; readonly onTabChange?: (tab: JobWorkspaceTab) => void; readonly returnLabel?: string; readonly initialResumeMode?: PreparationResumeMode | null; readonly onResumeModeChange?: (mode: PreparationResumeMode) => void; readonly renderProfileSetup?: (mode: PreparationResumeMode | null) => ReactNode }) {
  const features = useMountedFeatures();
  const settings = useApplicationSettings();
  const mode = initialResumeMode ?? settings.data?.resumeMode ?? null;
  return <JobDetailDrawer jobId={jobId} onClose={onClose} {...(returnLabel ? { returnLabel } : {})} {...(activeTab ? { activeTab } : {})} {...(onTabChange ? { onTabChange } : {})} affectedMatches={features.has("fit") ? <AffectedMatchesPanel jobIds={[jobId]} {...(renderProfileSetup ? { profileSetup: renderProfileSetup(mode) } : {})} /> : null} {...(features.has("preparation") ? { preparationControls: (input) => <JobActions jobId={jobId} {...input} initialMode={initialResumeMode} {...(onResumeModeChange ? { onModeChange: onResumeModeChange } : {})} {...(renderProfileSetup ? { renderProfileSetup } : {})} /> } : {})} optionalSections={[
    ...(features.has("companies") ? [{ id: "company", title: "Company briefing", description: "Review saved company context.", content: <CompanyBriefingForJob jobId={jobId} /> }] : []),
    ...(features.has("contacts") ? [{ id: "contacts", title: "Contacts", description: "Review people associated with this job.", content: <JobContactsPanel jobId={jobId} /> }] : []),
    ...(features.has("compensation") ? [{ id: "compensation", title: "Compensation", description: "Review saved compensation evidence.", content: <CompensationPanel jobId={jobId} /> }] : []),
    ...(features.has("offers") ? [{ id: "offers", title: "Offer", description: "Review offer terms and decisions.", content: <OfferPanel jobId={jobId}
      {...(features.has("compensation") ? { comparison: <OfferCompensationComparison jobId={jobId} /> } : {})}
      {...(features.has("outreach") && features.has("contacts") ? { renderCommunication: (revisionId: string) => <OfferCommunication jobId={jobId} revisionId={revisionId} /> } : {})} /> }] : []),
    ...(features.has("applications") ? [
      { id: "outcomes", title: "Application outcomes", description: "Review recorded application outcomes.", content: <JobOutcomePanel jobId={jobId} /> },
      { id: "application", title: "Application", description: "Prepare and review this application.", content: <ApplicationPanel jobId={jobId} /> },
      { id: "screening", title: "Screening answers", description: "Review reusable answers for this job.", content: <ScreeningAnswerLibrary jobId={jobId} /> },
    ] : []),
    ...(features.has("interviews") ? [{ id: "interviews", title: "Interview preparation", description: "Prepare and review interview materials.", content: <InterviewPrepForJob jobId={jobId} /> }] : []),
  ]} />;
}
