import { Link, Outlet, useRouterState } from "@tanstack/react-router";

import { CardHeader } from "../../../shared/ui/card-header.js";

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
  return (
    <section className="card full">
      <CardHeader title="Resume import" meta="three-step wizard" />
      <nav className="wizard-steps" aria-label="Wizard steps">
        {STEPS.map((step) => {
          const active = pathname === step.to;
          return (
            <Link
              key={step.key}
              to={step.to}
              className={`tab ${active ? "on" : ""}`}
              aria-current={active ? "step" : undefined}
            >
              {step.label}
            </Link>
          );
        })}
      </nav>
      <div className="wizard-body">
        <Outlet />
      </div>
    </section>
  );
}
