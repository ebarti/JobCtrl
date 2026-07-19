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
import {
  hasProfileImportUpload,
  useProfileImportStore,
} from "../stores/profile-import-store.js";

const STEPS: ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly compactLabel: string;
  readonly description: string;
  readonly to:
    | "/profile/import/upload"
    | "/profile/import/preview"
    | "/profile/import/confirm";
}> = [
  {
    key: "upload",
    label: "Upload PDF",
    compactLabel: "Upload",
    description: "Choose the source resume",
    to: "/profile/import/upload",
  },
  {
    key: "preview",
    label: "Preview options",
    compactLabel: "Options",
    description: "Review the PDF and scope",
    to: "/profile/import/preview",
  },
  {
    key: "confirm",
    label: "Confirm import",
    compactLabel: "Confirm",
    description: "Apply the selected data",
    to: "/profile/import/confirm",
  },
];

export function ResumeImportWizard() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const uploadAvailable = useProfileImportStore(hasProfileImportUpload);
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
          activeStepIndex > 0 ? (
            <Link
              className={buttonVariants({ variant: "outline", size: "sm" })}
              to="/profile"
            >
              Back to profile
            </Link>
          ) : undefined
        }
      />

      <Card
        className="resume-import-wizard"
        role="region"
        aria-labelledby="resume-import-wizard-title"
      >
        <CardHeader className="resume-import-wizard__header">
          <div>
            <CardTitle
              id="resume-import-wizard-title"
              role="heading"
              aria-level={2}
            >
              Resume import
            </CardTitle>
            <CardDescription>
              Upload, inspect, and confirm one PDF in three clear steps.
            </CardDescription>
          </div>
          <span
            className="resume-import-wizard__progress"
            data-typography="metadata"
            aria-live="polite"
          >
            Step {activeStepIndex + 1} of {STEPS.length}
          </span>
        </CardHeader>

        <nav className="resume-import-steps" aria-label="Resume import steps">
          {STEPS.map((step, index) => {
            const active = pathname === step.to;
            const available = index === 0 || uploadAvailable;
            const content = (
              <>
                <span
                  className="resume-import-step-link__number"
                  data-typography="metadata"
                  aria-hidden="true"
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span
                  className="resume-import-step-link__copy"
                  aria-hidden="true"
                >
                  <strong data-typography="control">
                    <span className="resume-import-step-link__label">
                      {step.label}
                    </span>
                    <span className="resume-import-step-link__compact-label">
                      {step.compactLabel}
                    </span>
                  </strong>
                  <small data-typography="metadata">{step.description}</small>
                </span>
              </>
            );

            return available ? (
              <Link
                key={step.key}
                to={step.to}
                className="resume-import-step-link"
                aria-label={`Step ${index + 1}: ${step.label}`}
                aria-current={active ? "step" : undefined}
                data-active={active || undefined}
                data-complete={index < activeStepIndex || undefined}
              >
                {content}
              </Link>
            ) : (
              <span
                key={step.key}
                className="resume-import-step-link"
                role="link"
                aria-label={`Step ${index + 1}: ${step.label}, unavailable until a PDF is selected`}
                aria-disabled="true"
                data-unavailable
              >
                {content}
              </span>
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
