import {
  CONTACT_ATTRIBUTE_KINDS,
  type ContactAttributeKind,
  type ContactRole,
  type ContactSourceKind,
} from "@jobctrl/contracts";

export const CONTACT_ROLE_LABELS: Record<ContactRole, string> = {
  recruiter: "Recruiter",
  hiring_manager: "Hiring manager",
  referrer: "Referrer",
  warm_intro: "Warm intro",
  other: "Other",
};

export const CONTACT_SOURCE_KIND_LABELS: Record<ContactSourceKind, string> = {
  user_entered: "Entered by you",
  public_web_page: "Public web page",
  user_imported_list: "Imported list",
  derived: "Derived",
};

export const CONTACT_ATTRIBUTE_KIND_LABELS: Record<ContactAttributeKind, string> = {
  name: "Name",
  title: "Title",
  email: "Email",
  phone: "Phone",
  profile_url: "Profile URL",
  note: "Note",
};

export function contactRoleLabel(role: ContactRole): string {
  return CONTACT_ROLE_LABELS[role];
}

export function contactSourceKindLabel(kind: ContactSourceKind): string {
  return CONTACT_SOURCE_KIND_LABELS[kind];
}

export function contactAttributeKindLabel(kind: string): string {
  return (CONTACT_ATTRIBUTE_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

export function toContactAttributeKind(kind: string): ContactAttributeKind {
  return (CONTACT_ATTRIBUTE_KINDS as readonly string[]).includes(kind)
    ? (kind as ContactAttributeKind)
    : "note";
}
