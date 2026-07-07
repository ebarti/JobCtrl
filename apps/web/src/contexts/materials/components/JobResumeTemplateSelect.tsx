import type { ResumeTemplateSummary, ResumeTemplateState } from "@jobctl/contracts";
import type { JSX } from "react";
import { useId } from "react";

import { ResumeTemplateStatusBadge } from "./ResumeTemplateStatusBadge.js";

export interface JobResumeTemplateSelectProps {
  readonly current?: ResumeTemplateState | null | undefined;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly onTemplateChange: (templateId: string | null) => void;
  readonly refreshing?: boolean;
  readonly templates: readonly ResumeTemplateSummary[];
}

export function JobResumeTemplateSelect({
  current,
  disabled,
  label = "Resume template",
  onTemplateChange,
  refreshing,
  templates,
}: JobResumeTemplateSelectProps): JSX.Element {
  const refreshStatusId = useId();
  const selectedValue =
    current?.effective.assignmentSource === "job_override"
      ? current.effective.templateId
      : "inherit";
  const inheritedName =
    current?.effective.assignmentSource === "profile_default"
      ? `Use default (${current.effective.templateName})`
      : current?.effective.assignmentSource === "built_in"
        ? `Use built-in (${current.effective.templateName})`
        : "Use default";

  return (
    <div className="resume-template-job-select">
      <label className="field compact">
        <span>{label}</span>
        <select
          aria-describedby={refreshing ? refreshStatusId : undefined}
          disabled={disabled}
          value={selectedValue}
          onChange={(event) => onTemplateChange(event.target.value === "inherit" ? null : event.target.value)}
        >
          <option value="inherit">{inheritedName}</option>
          {templates.map((template) => (
            <option key={template.templateId} value={template.templateId}>
              {template.displayName}
            </option>
          ))}
        </select>
      </label>
      <div className="resume-template-job-select-status" aria-live="polite">
        <ResumeTemplateStatusBadge state={current} />
        {refreshing ? (
          <span className="tag info" id={refreshStatusId}>
            updating materials
          </span>
        ) : null}
      </div>
    </div>
  );
}
