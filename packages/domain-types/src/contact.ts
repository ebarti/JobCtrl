/** Public contact vocabulary shared by the HTTP forms. */
export const CONTACT_SOURCE_KINDS = [
  "user_entered",
  "public_web_page",
  "user_imported_list",
  "derived",
] as const;
export type ContactSourceKind = (typeof CONTACT_SOURCE_KINDS)[number];

export const CONTACT_ROLES = [
  "recruiter",
  "hiring_manager",
  "referrer",
  "warm_intro",
  "other",
] as const;
export type ContactRoleValue = (typeof CONTACT_ROLES)[number];
