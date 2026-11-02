import type {
  ContactCreateRequest,
  ContactDetail,
  ContactDetailResponse,
  ContactListResponse,
  ContactSummary,
  ContactUpdateRequest,
} from "@jobctrl/contracts";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import {
  applyPartialQueryPatch,
  publicationUnchangedExcept,
  snapshotOptimisticPublication,
  type OptimisticPublicationSnapshot,
} from "../../../shared/lib/createOptimisticMutation.js";

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

let optimisticContactSequence = 0;

function newOptimisticContactId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `optimistic-${crypto.randomUUID()}`;
  }
  return `optimistic-${Date.now()}-${++optimisticContactSequence}`;
}

function contactListMatch(queryKey: QueryKey, prefixLength: number, contact: Pick<ContactSummary, "jobId" | "employer">): "included" | "excluded" | "unknown" {
  if (queryKey.length > prefixLength + 1) return "unknown";
  const raw = queryKey[prefixLength];
  if (raw === undefined) return "included";
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "unknown";
  const filters = raw as Record<string, unknown>;
  if (Object.keys(filters).some((key) => key !== "jobId" && key !== "employer")) return "unknown";
  const keys = ["jobId", "employer"] as const;
  if (keys.some((key) => filters[key] != null && typeof filters[key] !== "string")) return "unknown";
  return keys.every((key) => {
    const value = filters[key];
    return typeof value !== "string" || !value.trim() || contact[key]?.trim() === value.trim();
  }) ? "included" : "excluded";
}

/** Match the literal filters used by the contact-list API. */
export function matchesContactList(queryKey: QueryKey, prefixLength: number, contact: Pick<ContactSummary, "jobId" | "employer">): boolean {
  return contactListMatch(queryKey, prefixLength, contact) === "included";
}

/** Unknown filters remain relevant; only a proven mismatch can be skipped. */
export function contactListMayInclude(queryKey: QueryKey, prefixLength: number, contact: Pick<ContactSummary, "jobId" | "employer">): boolean {
  return contactListMatch(queryKey, prefixLength, contact) !== "excluded";
}

/** Build the same deterministic summary returned by the contact projection. */
export function contactSummaryFromDetail(contact: ContactDetail): ContactSummary {
  const confirmedCount = contact.attributes.filter((attribute) => attribute.provenance.userConfirmed).length;
  return {
    contactId: contact.contactId,
    displayName: contact.displayName,
    role: contact.role,
    employer: contact.employer,
    jobId: contact.jobId,
    attributeCount: contact.attributes.length,
    confirmedCount,
    sourceKinds: [...new Set(contact.attributes.map((attribute) => attribute.provenance.sourceKind))],
    allConfirmed: contact.attributes.length > 0 && confirmedCount === contact.attributes.length,
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
  };
}

/** Capture publication authority without owning or cancelling list queries. */
export function snapshotContactLists(client: QueryClient, prefix: QueryKey, contactId: string): OptimisticPublicationSnapshot[] {
  return client.getQueryCache().findAll({ queryKey: prefix }).map((query) => {
    const alreadyPresent = !contactId.startsWith("optimistic-") && isContactListResponse(query.state.data) &&
      query.state.data.items.some((item) => item.contactId === contactId);
    return snapshotOptimisticPublication(client, query, (tag) => {
      if (!tag || typeof tag !== "object" || !("kind" in tag)) return false;
      if (tag.kind === "contact" && "contactId" in tag) return typeof tag.contactId === "string" && tag.contactId !== contactId;
      // A newly allocated server ID cannot be an existing row from before the create.
      return tag.kind === "contact-create" && alreadyPresent && "provisionalId" in tag &&
        typeof tag.provisionalId === "string" && tag.provisionalId !== contactId;
    });
  });
}

/** Merge a confirmed row unless a newer full or same-contact publication won. */
export function publishContactResponse(
  client: QueryClient,
  prefix: QueryKey,
  snapshots: readonly OptimisticPublicationSnapshot[],
  response: { readonly kind: "update"; readonly contact: ContactDetail } | { readonly kind: "delete"; readonly contactId: string },
): void {
  for (const snapshot of snapshots) {
    const { query } = snapshot;
    const match = response.kind === "update" ? contactListMatch(query.queryKey, prefix.length, response.contact) : "excluded";
    const contactId = response.kind === "update" ? response.contact.contactId : response.contactId;
    if (client.getQueryCache().get(query.queryHash) !== query || !publicationUnchangedExcept(snapshot)) continue;
    if (match === "unknown") continue;
    // Even an unchanged absence confirms this contact's state and fences an
    // older response that would otherwise insert it into this list.
    applyPartialQueryPatch(client, query, (current) => {
      if (!isContactListResponse(current)) return current;
      const remaining = current.items.filter((item) => item.contactId !== contactId);
      if (match === "excluded") return remaining.length === current.items.length ? current : { ...current, items: remaining };
      if (response.kind !== "update") return current;
      const summary = contactSummaryFromDetail(response.contact);
      const index = remaining.findIndex((item) => {
        if (summary.updatedAt !== item.updatedAt) {
          if (summary.updatedAt === null) return false;
          if (item.updatedAt === null) return true;
          return summary.updatedAt > item.updatedAt;
        }
        return summary.contactId < item.contactId;
      });
      remaining.splice(index < 0 ? remaining.length : index, 0, summary);
      return { ...current, items: remaining };
    }, { publicationTag: { kind: "contact", contactId } });
  }
}

/** Reconcile only the placeholder owned by this create operation. */
export function reconcileCreatedContact(
  current: unknown,
  provisionalId: string,
  contact: ContactDetail,
  included: boolean,
): unknown {
  if (!isContactListResponse(current) || !current.items.some((item) => item.contactId === provisionalId)) return current;
  const items = current.items.filter((item) => item.contactId !== provisionalId);
  if (!included || items.some((item) => item.contactId === contact.contactId)) return { ...current, items };
  const summary = contactSummaryFromDetail(contact);
  const index = items.findIndex((item) => {
    if (summary.updatedAt !== item.updatedAt) {
      if (summary.updatedAt === null) return false;
      if (item.updatedAt === null) return true;
      return summary.updatedAt > item.updatedAt;
    }
    return summary.contactId < item.contactId;
  });
  items.splice(index < 0 ? items.length : index, 0, summary);
  return { ...current, items };
}

export function provisionalContactSummary(body: ContactCreateRequest): ContactSummary {
  const nameValue = body.attributes.find((attribute) => attribute.kind === "name")?.value;
  return {
    contactId: newOptimisticContactId(),
    displayName: nameValue ?? body.employer ?? "New contact",
    role: body.role,
    employer: body.employer?.trim() || null,
    jobId: body.jobId?.trim() || null,
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
