import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

const PAGE_TITLES: Record<string, string> = {
  dashboard: "Dashboard",
  analytics: "Analytics",
  jobs: "Jobs",
  "apply-review": "Apply review",
  pipelines: "Pipelines",
  discovery: "Discovery",
  artifacts: "Artifacts",
  "evidence-map": "Evidence",
  outreach: "Contacts",
  runs: "Runs",
  debug: "Debug",
  activity: "Debug",
  profile: "Profile",
  preferences: "Preferences",
  settings: "Settings",
};

export function usePageTitle(): void {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useEffect(() => {
    const segment = pathname.split("/").filter(Boolean)[0];
    const name = segment ? PAGE_TITLES[segment] : undefined;
    document.title = name ? `JobCtrl · ${name}` : "JobCtrl";
  }, [pathname]);
}
