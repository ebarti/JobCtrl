import type { ResumeTemplateSummary, ResumeTemplateState } from "@jobhunter/contracts";
import { IconRefresh } from "@tabler/icons-react";
import type { JSX } from "react";

import { ResumeTemplateStatusBadge } from "./ResumeTemplateStatusBadge.js";

export interface JobResumeTemplateSelectProps {
  readonly current?: ResumeTemplateState | null | undefined;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly onEnsureCurrent?: () => void;
  readonly onTemplateChange: (templateId: string | null) => void;
  readonly refreshing?: boolean;
  readonly templates: readonly ResumeTemplateSummary[];
}

export function JobResumeTemplateSelect({
  current,
  disabled,
  label = "Resume template",
  onEnsureCurrent,
  onTemplateChange,
  refreshing,
  templates,
}: JobResumeTemplateSelectProps): JSX.Element {
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
      <ResumeTemplateStatusBadge state={current} />
      {onEnsureCurrent ? (
        <button
          aria-label="Refresh resume materials with the selected template"
          className="tab"
          disabled={disabled || refreshing || current?.state === "template_current"}
          type="button"
          onClick={onEnsureCurrent}
        >
          <IconRefresh size={14} aria-hidden="true" />
          {refreshing ? "refreshing" : "refresh"}
        </button>
      ) : null}
    </div>
  );
}
