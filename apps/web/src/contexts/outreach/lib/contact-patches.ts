import type {
  ContactCreateRequest,
  ContactDetailResponse,
  ContactListResponse,
  ContactSummary,
  ContactUpdateRequest,
} from "@jobhunter/contracts";

function isContactListResponse(value: unknown): value is ContactListResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "items" in value &&
    Array.isArray((value as ContactListResponse).items)
  );
}

function isContactDetailResponse(value: unknown): value is ContactDetailResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "contact" in value &&
    typeof (value as ContactDetailResponse).contact === "object"
  );
}

function newOptimisticContactId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `optimistic-${crypto.randomUUID()}`;
  }
  return `optimistic-${Date.now()}`;
}

export function provisionalContactSummary(body: ContactCreateRequest): ContactSummary {
  const nameValue = body.attributes.find((attribute) => attribute.kind === "name")?.value;
  return {
    contactId: newOptimisticContactId(),
    displayName: nameValue ?? body.employer ?? "New contact",
    role: body.role,
    employer: body.employer ?? null,
    jobId: body.jobId ?? null,
    attributeCount: body.attributes.length,
    confirmedCount: 0,
    sourceKinds: [],
    allConfirmed: false,
    createdAt: null,
    updatedAt: null,
  };
}

export function prependContactSummary(current: unknown, summary: ContactSummary): unknown {
  if (!isContactListResponse(current)) {
    return current;
  }
  return { ...current, items: [summary, ...current.items] };
}

export function removeContactFromList(current: unknown, contactId: string): unknown {
  if (!isContactListResponse(current)) {
    return current;
  }
  return { ...current, items: current.items.filter((item) => item.contactId !== contactId) };
}

export function patchContactSummaryInList(
  current: unknown,
  contactId: string,
  body: ContactUpdateRequest,
): unknown {
  if (!isContactListResponse(current)) {
    return current;
  }
  return {
    ...current,
    items: current.items.map((item) =>
      item.contactId === contactId
        ? {
            ...item,
            ...(body.role !== undefined ? { role: body.role } : {}),
            ...(body.employer !== undefined ? { employer: body.employer ?? null } : {}),
            ...(body.jobId !== undefined ? { jobId: body.jobId ?? null } : {}),
          }
        : item,
    ),
  };
}

export function patchContactDetail(current: unknown, body: ContactUpdateRequest): unknown {
  if (!isContactDetailResponse(current)) {
    return current;
  }
  return {
    ...current,
    contact: {
      ...current.contact,
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.employer !== undefined ? { employer: body.employer ?? null } : {}),
      ...(body.jobId !== undefined ? { jobId: body.jobId ?? null } : {}),
    },
  };
}
