import { JOB_AUDIT_TONES, type JobAuditEntry } from "@jobhunter/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { JobAuditHistory, jobAuditToneClass } from "./JobAuditHistory.js";

function auditEntry(tone: JobAuditEntry["tone"]): JobAuditEntry {
  return {
    id: `audit-${tone}`,
    category: "pipeline",
    tone,
    title: `${tone} audit entry`,
    description: null,
    occurredAt: null,
    actor: null,
    details: [],
  };
}

describe("<JobAuditHistory>", () => {
  it.each(JOB_AUDIT_TONES)("renders the closed %s audit tone", (tone) => {
    render(<JobAuditHistory entries={[auditEntry(tone)]} />);

    const row = screen.getByText(`${tone} audit entry`).closest("li");
    expect(row?.className).toContain(jobAuditToneClass(tone));
  });

  it("renders an explicit empty state", () => {
    render(<JobAuditHistory entries={[]} />);

    expect(screen.getByText("No audit history recorded for this job.")).toBeInTheDocument();
  });
});

