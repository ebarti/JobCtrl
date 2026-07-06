import type {
  ContactAttributeDto,
  ContactDetail,
  ContactDetailResponse,
  ContactFactProvenance,
  ContactListResponse,
  ContactMutationResponse,
  ContactSummary,
} from "@jobhunter/contracts";

export function makeContactProvenance(
  overrides: Partial<ContactFactProvenance> = {},
): ContactFactProvenance {
  return {
    sourceKind: "user_entered",
    sourceRef: "profile:manual-entry",
    captureMethod: "manual_form",
    capturedAt: "2026-06-30T09:00:00+00:00",
    confidence: 1,
    userConfirmed: true,
    ...overrides,
  };
}

export const sampleContactAttributes: ContactAttributeDto[] = [
  {
    attributeId: "attr-name",
    kind: "name",
    value: "Dana Reyes",
    provenance: makeContactProvenance(),
  },
  {
    attributeId: "attr-title",
    kind: "title",
    value: "Staff Recruiter",
    provenance: makeContactProvenance({
      sourceKind: "public_web_page",
      sourceRef: "https://acme.example/team/dana-reyes",
      captureMethod: "web_capture",
      capturedAt: "2026-06-30T09:05:00+00:00",
      confidence: 0.72,
      userConfirmed: false,
    }),
  },
  {
    attributeId: "attr-email",
    kind: "email",
    value: "dana.reyes@acme.example",
    provenance: makeContactProvenance({
      sourceKind: "user_imported_list",
      sourceRef: "import:contacts-2026-06.csv#row-4",
      captureMethod: "csv_import",
      capturedAt: "2026-06-30T09:10:00+00:00",
      confidence: 0.9,
      userConfirmed: false,
    }),
  },
];

export function makeContactDetail(overrides: Partial<ContactDetail> = {}): ContactDetail {
  return {
    contactId: "contact-1",
    displayName: "Dana Reyes",
    role: "recruiter",
    employer: "Acme",
    jobId: "job-1",
    attributes: sampleContactAttributes,
    createdAt: "2026-06-30T09:00:00+00:00",
    updatedAt: "2026-06-30T09:10:00+00:00",
    ...overrides,
  };
}

export const sampleContactDetail: ContactDetail = makeContactDetail();

export function makeContactSummary(overrides: Partial<ContactSummary> = {}): ContactSummary {
  return {
    contactId: "contact-1",
    displayName: "Dana Reyes",
    role: "recruiter",
    employer: "Acme",
    jobId: "job-1",
    attributeCount: 3,
    confirmedCount: 1,
    sourceKinds: ["user_entered", "public_web_page", "user_imported_list"],
    allConfirmed: false,
    createdAt: "2026-06-30T09:00:00+00:00",
    updatedAt: "2026-06-30T09:10:00+00:00",
    ...overrides,
  };
}

export const sampleContactSummary: ContactSummary = makeContactSummary();

export const sampleSecondaryContactSummary: ContactSummary = makeContactSummary({
  contactId: "contact-2",
  displayName: "Morgan Blake",
  role: "hiring_manager",
  employer: "Acme",
  jobId: null,
  attributeCount: 2,
  confirmedCount: 2,
  sourceKinds: ["user_entered"],
  allConfirmed: true,
});

export function makeContactListResponse(
  items: readonly ContactSummary[] = [sampleContactSummary, sampleSecondaryContactSummary],
): ContactListResponse {
  return { ok: true, items: [...items] };
}

export function makeContactDetailResponse(
  contact: ContactDetail = sampleContactDetail,
): ContactDetailResponse {
  return { ok: true, contact };
}

export function makeContactMutationResponse(
  contact: ContactDetail = sampleContactDetail,
): ContactMutationResponse {
  return { ok: true, contact };
}
