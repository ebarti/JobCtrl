import type { ReactNode } from "react";

import { JobPreparationActions } from "./PreparationControls.js";
import type { PreparationResumeMode } from "../client.js";

export interface JobActionsProps {
  readonly jobId: string;
  readonly defaultMode?: PreparationResumeMode | null;
  readonly initialMode?: PreparationResumeMode | null;
  readonly onModeChange?: (mode: PreparationResumeMode) => void;
  readonly renderProfileSetup?: (mode: PreparationResumeMode | null) => ReactNode;
  readonly profileVersion?: number | null;
  readonly blockedByDraft?: boolean;
  readonly onReviewReady?: (resumeId?: string, runId?: string) => void;
}

export function JobActions(props: JobActionsProps) {
  return <JobPreparationActions {...props} />;
}
