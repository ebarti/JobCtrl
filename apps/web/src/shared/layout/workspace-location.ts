export type Workspace = "jobs" | "profile" | "settings";

const profileSections: Record<string, string> = {
  experience: "Experience",
  skills: "Skills",
  education: "Education",
  languages: "Languages",
  personal: "Personal details",
  resume: "Resume",
};

type ProfileSection = "experience" | "skills" | "education" | "languages" | "personal" | "resume";
const legacyProfileAnchors: Record<string, ProfileSection> = {
  "profile-personal": "personal", "profile-eeo": "personal",
  "profile-baseline": "experience", "profile-experience": "experience",
  "profile-education": "education", "profile-skills": "skills",
  "profile-languages": "languages",
  "profile-resume-editor": "resume",
};

export function profileSectionForLocation(search: Record<string, unknown>, hash = ""): ProfileSection {
  if (typeof search.section === "string" && Object.prototype.hasOwnProperty.call(profileSections, search.section)) return search.section as ProfileSection;
  return Object.prototype.hasOwnProperty.call(legacyProfileAnchors, hash) ? legacyProfileAnchors[hash]! : "experience";
}

const pageNames: Record<string, string> = {
  jobs: "All jobs", requirements: "Requirements", "apply-review": "Applications",
  analytics: "Outcomes", interviews: "Interview library", outreach: "Contacts",
  discovery: "Search for jobs", artifacts: "Materials", dashboard: "Dashboard",
  pipelines: "Preparation", profile: "Experience", learning: "Learning",
  preferences: "Search preferences", "evidence-map": "Career evidence",
  settings: "Connections", runs: "Task history", debug: "Recorded events", activity: "Recorded events",
};

const settingsPages: Record<string, string> = {
  credentials: "Connections", models: "Connections", browser: "Connections",
  budgets: "Budgets", automation: "Automation", appearance: "Appearance", data: "Data & diagnostics",
};

export function workspaceLocation(
  pathname: string,
  search: Record<string, unknown> = {},
  hash = "",
): { workspace: Workspace; label: string } {
  const [first = "jobs", second] = pathname.split("/").filter(Boolean);
  const workspace: Workspace = ["profile", "learning", "preferences", "evidence-map"].includes(first)
    ? "profile"
    : ["settings", "runs", "debug", "activity"].includes(first)
      ? "settings"
      : "jobs";

  const label = first === "profile" && second === "import"
    ? "Import resume"
    : first === "profile"
      ? profileSections[profileSectionForLocation(search, hash)] ?? "Experience"
      : first === "settings" && second
        ? settingsPages[second] ?? "Settings"
        : pageNames[first] ?? "Jobs";

  return { workspace, label };
}

export const WORKSPACE_LABELS: Record<Workspace, string> = {
  jobs: "Jobs", profile: "My profile", settings: "Settings",
};
