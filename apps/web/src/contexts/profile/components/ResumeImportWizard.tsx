import { Link, Outlet, useRouterState } from "@tanstack/react-router";

import { Card } from "../../../shared/ui/card.js";
import { PageHead } from "../../../shared/ui/page-head.js";
import { SectionTabs, SectionTabsList } from "../../../shared/ui/section-tabs.js";
import { TabsContent, TabsTrigger } from "../../../shared/ui/tabs.js";

const STEPS: ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly to: "/profile/import/upload" | "/profile/import/preview" | "/profile/import/confirm";
}> = [
  { key: "upload", label: "1 · Upload PDF", to: "/profile/import/upload" },
  { key: "preview", label: "2 · Preview options", to: "/profile/import/preview" },
  { key: "confirm", label: "3 · Confirm import", to: "/profile/import/confirm" },
];

export function ResumeImportWizard() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeStep = STEPS.find((step) => step.to === pathname)?.to ?? "/profile/import/upload";

  return (
    <div className="route-page resume-import-wizard">
      <PageHead
        eyebrow="Profile"
        title="Resume import"
        subtitle="Upload a PDF, choose the sections to import, then confirm."
      />
      <Card className="resume-import-wizard__card overflow-hidden shadow-none">
        <SectionTabs className="resume-import-wizard__tabs" value={activeStep}>
          <nav className="resume-import-wizard__steps px-4 pt-2" aria-label="Wizard steps">
            <SectionTabsList>
              {STEPS.map((step) => {
                const active = activeStep === step.to;
                return (
                  <TabsTrigger
                    key={step.key}
                    value={step.to}
                    className="data-[state=active]:border-foreground"
                    asChild
                  >
                    <Link
                      to={step.to}
                      aria-current={active ? "step" : undefined}
                    >
                      {step.label}
                    </Link>
                  </TabsTrigger>
                );
              })}
            </SectionTabsList>
          </nav>
          <TabsContent
            className="resume-import-wizard__content m-0 p-4"
            value={activeStep}
            forceMount
          >
            <Outlet />
          </TabsContent>
        </SectionTabs>
      </Card>
    </div>
  );
}
