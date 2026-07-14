import {
  IconArrowLeft,
  IconCheck,
  IconFileTypePdf,
} from "@tabler/icons-react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";

import { Button } from "../../../shared/ui/button.js";
import { Card } from "../../../shared/ui/card.js";
import { PageHead } from "../../../shared/ui/page-head.js";
import { SectionTabs, SectionTabsList } from "../../../shared/ui/section-tabs.js";
import { TabsContent, TabsTrigger } from "../../../shared/ui/tabs.js";

const STEPS: ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly to: "/profile/import/upload" | "/profile/import/preview" | "/profile/import/confirm";
}> = [
  { key: "upload", label: "Upload PDF", to: "/profile/import/upload" },
  { key: "preview", label: "Preview options", to: "/profile/import/preview" },
  { key: "confirm", label: "Confirm import", to: "/profile/import/confirm" },
];

export function ResumeImportWizard() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const atStart = pathname === "/profile/import";
  const activeStep = STEPS.find((step) => step.to === pathname)?.to ?? "/profile/import/upload";
  const activeStepIndex = Math.max(0, STEPS.findIndex((step) => step.to === activeStep));

  return (
    <div className="route-page route-page--profile-import resume-import-wizard">
      <PageHead
        eyebrow="Profile import"
        title="Import resume"
        subtitle={(
          <>
            <span>Read a local PDF, choose what to import, then confirm the change.</span>
            <small>The source file never leaves this device.</small>
          </>
        )}
        actions={(
          <Button asChild size="sm" variant="ghost">
            <Link to="/profile">
              <IconArrowLeft aria-hidden="true" size={16} stroke={1.9} />
              Back to profile
            </Link>
          </Button>
        )}
      />
      <Card className="resume-import-wizard__card overflow-hidden shadow-none">
        <SectionTabs className="resume-import-wizard__tabs" value={activeStep}>
          <nav className="resume-import-wizard__steps" aria-label="Wizard steps">
            <SectionTabsList>
              {STEPS.map((step, index) => {
                const active = activeStep === step.to;
                const complete = index < activeStepIndex;
                return (
                  <TabsTrigger
                    key={step.key}
                    value={step.to}
                    className="resume-import-wizard__step"
                    data-step-state={active ? "active" : complete ? "complete" : "upcoming"}
                    asChild
                  >
                    <Link
                      to={step.to}
                      aria-current={active ? "step" : undefined}
                    >
                      <span className="resume-import-wizard__step-number" aria-hidden="true">
                        {complete ? (
                          <IconCheck size={15} stroke={2} />
                        ) : (
                          String(index + 1).padStart(2, "0")
                        )}
                      </span>
                      <span className="resume-import-wizard__step-label">{step.label}</span>
                    </Link>
                  </TabsTrigger>
                );
              })}
            </SectionTabsList>
          </nav>
          <TabsContent
            className="resume-import-wizard__content m-0 p-0"
            value={activeStep}
            forceMount
          >
            {atStart ? <ResumeImportStart /> : <Outlet />}
          </TabsContent>
        </SectionTabs>
      </Card>
    </div>
  );
}

function ResumeImportStart() {
  return (
    <section className="resume-import-start" aria-labelledby="resume-import-start-title">
      <IconFileTypePdf aria-hidden="true" size={28} stroke={1.6} />
      <div className="resume-import-start__copy">
        <h2 id="resume-import-start-title">Start with the source file</h2>
        <p>
          Choose a local PDF. JobCtrl separates canonical profile evidence from presentation
          style, and nothing is imported until the final confirmation.
        </p>
      </div>
      <Button asChild>
        <Link to="/profile/import/upload">Choose PDF</Link>
      </Button>
    </section>
  );
}
