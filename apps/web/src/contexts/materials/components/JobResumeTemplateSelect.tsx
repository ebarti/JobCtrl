import type {
  ResumeTemplateSummary,
  ResumeTemplateState,
} from "@jobctrl/contracts";
import { IconRefresh } from "@tabler/icons-react";
import type { JSX } from "react";
import { useId } from "react";

import { StatusBadge } from "../../../shared/ui/status-badge.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../shared/ui/select.js";
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
  const selectId = useId();
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
  const items = [
    { label: inheritedName, value: "inherit" },
    ...templates.map((template) => ({
      label: template.displayName,
      value: template.templateId,
    })),
  ];

  return (
    <div className="resume-template-job-select">
      <label className="field compact">
        <span data-typography="label">{label}</span>
        <Select
          disabled={disabled}
          items={items}
          value={selectedValue}
          onValueChange={(nextValue) => {
            if (nextValue !== null) {
              onTemplateChange(nextValue === "inherit" ? null : nextValue);
            }
          }}
        >
          <SelectTrigger
            id={selectId}
            aria-label={label}
            aria-describedby={refreshing ? refreshStatusId : undefined}
            className="w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </label>
      <div className="resume-template-job-select-status" aria-live="polite">
        <ResumeTemplateStatusBadge state={current} />
        {refreshing ? (
          <StatusBadge icon={IconRefresh} id={refreshStatusId} tone="info">
            updating materials
          </StatusBadge>
        ) : null}
      </div>
    </div>
  );
}
