import { Link, Outlet, useRouterState } from "@tanstack/react-router";

import { buttonVariants } from "../../../shared/ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../shared/ui/card.js";
import { PageHead } from "../../../shared/ui/page-head.js";

const STEPS: ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly to: "/profile/import/upload" | "/profile/import/preview" | "/profile/import/confirm";
}> = [
  {
    key: "upload",
    label: "Upload PDF",
    description: "Choose the source resume",
    to: "/profile/import/upload",
  },
  {
    key: "preview",
    label: "Preview options",
    description: "Review the PDF and scope",
    to: "/profile/import/preview",
  },
  {
    key: "confirm",
    label: "Confirm import",
    description: "Apply the selected data",
    to: "/profile/import/confirm",
  },
];

export function ResumeImportWizard() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeStepIndex = Math.max(
    0,
    STEPS.findIndex((step) => step.to === pathname),
  );

  return (
    <div className="resume-import-page">
      <PageHead
        eyebrow="Setup"
        title="Import resume"
        subtitle="Bring an existing resume into your canonical profile without losing control over which data is imported."
        actions={
          <Link className={buttonVariants({ variant: "outline", size: "sm" })} to="/profile">
            Back to profile
          </Link>
        }
      />

      <Card
        className="resume-import-wizard"
        role="region"
        aria-labelledby="resume-import-wizard-title"
      >
        <CardHeader className="resume-import-wizard__header">
          <div>
            <CardTitle id="resume-import-wizard-title" role="heading" aria-level={2}>
              Resume import
            </CardTitle>
            <CardDescription>
              Upload, inspect, and confirm one PDF in three clear steps.
            </CardDescription>
          </div>
          <span className="resume-import-wizard__progress" aria-live="polite">
            Step {activeStepIndex + 1} of {STEPS.length}
          </span>
        </CardHeader>

        <nav className="resume-import-steps" aria-label="Resume import steps">
          {STEPS.map((step, index) => {
            const active = pathname === step.to;
            return (
              <Link
                key={step.key}
                to={step.to}
                className="resume-import-step-link"
                aria-current={active ? "step" : undefined}
                data-active={active || undefined}
                data-complete={index < activeStepIndex || undefined}
              >
                <span className="resume-import-step-link__number" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="resume-import-step-link__copy">
                  <strong>{step.label}</strong>
                  <small>{step.description}</small>
                </span>
              </Link>
            );
          })}
        </nav>

        <CardContent className="resume-import-wizard__content">
          <Outlet />
        </CardContent>
      </Card>
    </div>
  );
}
