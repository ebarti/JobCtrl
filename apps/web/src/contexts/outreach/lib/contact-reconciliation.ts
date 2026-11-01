import { CONTACT_ATTRIBUTE_KINDS, type ContactAttributeDto, type ContactDetail } from "@jobctrl/contracts";

import type { ContactAttributeRow, ContactFormValues } from "../forms/contact-form.js";
import { toContactAttributeKind } from "./contact-copy.js";

export type ContactReconciliationChoice = "draft" | "latest";

export interface ContactReconciliationConflict {
  key: string;
  label: string;
  draft: string;
  latest: string;
  draftAction?: string;
  latestAction?: string;
}

export interface ContactReconciliation {
  values: ContactFormValues;
  conflicts: ContactReconciliationConflict[];
}

function factRow(fact: ContactAttributeDto): ContactAttributeRow {
  return { attributeId: fact.attributeId, kind: toContactAttributeKind(fact.kind), value: fact.value,
    ...(!(CONTACT_ATTRIBUTE_KINDS as readonly string[]).includes(fact.kind) ? { unsupportedKind: fact.kind } : {}) };
}

export function contactFormValues(contact: ContactDetail): ContactFormValues {
  return {
    role: contact.role,
    employer: contact.employer ?? "",
    jobId: contact.jobId ?? "",
    attributes: contact.attributes.map(factRow),
  };
}

export function draftFactChanged(original: ContactAttributeDto, draft: ContactAttributeRow | undefined): boolean {
  return !draft || draft.kind !== toContactAttributeKind(original.kind) ||
    (draft.value !== original.value && draft.value.trim() !== original.value);
}

function sameSavedFact(first: ContactAttributeDto, second: ContactAttributeDto): boolean {
  const a = first.provenance;
  const b = second.provenance;
  return first.kind === second.kind && first.value === second.value &&
    a.sourceKind === b.sourceKind && a.sourceRef === b.sourceRef &&
    a.captureMethod === b.captureMethod && a.capturedAt === b.capturedAt &&
    a.confidence === b.confidence && a.userConfirmed === b.userConfirmed;
}

/** Replacement is unnecessary when the user only edited other contact fields. */
export function contactFactsChanged(base: ContactDetail, draft: ContactFormValues): boolean {
  const baseIds = new Set(base.attributes.map((fact) => fact.attributeId));
  const rows = new Map(draft.attributes.flatMap((row) => row.attributeId !== undefined ? [[row.attributeId, row] as const] : []));
  return base.attributes.some((fact) => draftFactChanged(fact, rows.get(fact.attributeId))) ||
    draft.attributes.some((row) => (row.attributeId === undefined || !baseIds.has(row.attributeId)) && row.value.trim() !== "");
}

/** Merge only changes that can be attributed to a saved fact identity. */
export function reconcileContact(
  base: ContactDetail,
  draft: ContactFormValues,
  latest: ContactDetail,
  choices: Readonly<Record<string, ContactReconciliationChoice>> = {},
): ContactReconciliation {
  const conflicts: ContactReconciliationConflict[] = [];
  function scalar<T extends string>(key: string, label: string, original: T, mine: T, current: T): T {
    if (mine === original) return current;
    if (current === original || mine === current) return mine;
    conflicts.push({ key, label, draft: mine || "None", latest: current || "None" });
    return choices[key] === "latest" ? current : mine;
  }

  const values: ContactFormValues = {
    role: scalar("role", "Role", base.role, draft.role, latest.role),
    employer: scalar("employer", "Employer", base.employer ?? "", draft.employer.trim(), latest.employer ?? ""),
    jobId: scalar("jobId", "Job", base.jobId ?? "", draft.jobId.trim(), latest.jobId ?? ""),
    attributes: [],
  };
  const originalIds = new Set(base.attributes.map((fact) => fact.attributeId));
  const draftById = new Map(draft.attributes.flatMap((row) => row.attributeId !== undefined ? [[row.attributeId, row] as const] : []));
  const latestById = new Map(latest.attributes.map((fact) => [fact.attributeId, fact]));
  const changedAndMissing = base.attributes.some((fact) =>
    !latestById.has(fact.attributeId) && draftFactChanged(fact, draftById.get(fact.attributeId)));

  base.attributes.forEach((original, index) => {
    const rawDraft = draftById.get(original.attributeId);
    // Clearing a nonempty fact is an explicit deletion, as in the form submit.
    const mine = rawDraft && (rawDraft.value.trim() !== "" || original.value.trim() === "") ? rawDraft : undefined;
    const current = latestById.get(original.attributeId);
    if (!draftFactChanged(original, mine)) {
      if (current) values.attributes.push(factRow(current));
      return;
    }
    if (current && sameSavedFact(original, current)) {
      if (mine) values.attributes.push(mine);
      return;
    }
    if (!mine && !current) return;
    if (mine && current && mine.kind === current.kind && mine.value.trim() === current.value.trim()) {
      values.attributes.push(factRow(current));
      return;
    }
    const key = `fact:${original.attributeId}`;
    conflicts.push({ key, label: `Fact ${index + 1}`,
      draft: mine ? `${mine.kind}: ${mine.value}` : "Deleted",
      latest: current ? `${current.kind}: ${current.value}` : "Deleted" });
    if (choices[key] === "latest") {
      if (current) values.attributes.push(factRow(current));
    } else if (mine) {
      if (current) values.attributes.push(mine);
      else {
        const { attributeId: _deletedId, ...newFact } = mine;
        values.attributes.push(newFact);
      }
    }
  });

  // A changed fact receives a new ID. If a draft-changed original disappeared,
  // no identity link proves whether a new fact replaces it. Ask the user to
  // keep or remove each new fact rather than guessing from its content.
  let newIndex = 0;
  for (const fact of latest.attributes) {
    if (originalIds.has(fact.attributeId)) continue;
    newIndex += 1;
    const key = `added:${fact.attributeId}`;
    if (changedAndMissing) {
      conflicts.push({ key, label: `New fact ${newIndex}`, draft: "Removed",
        latest: `${fact.kind}: ${fact.value}`,
        draftAction: "Remove added fact", latestAction: "Keep added fact" });
    }
    if (!changedAndMissing || choices[key] !== "draft") values.attributes.push(factRow(fact));
  }
  // Preserve new draft rows, including a previously reconciled deleted fact.
  for (const row of draft.attributes) {
    if ((row.attributeId === undefined || !originalIds.has(row.attributeId)) && row.value.trim() !== "") values.attributes.push(row);
  }
  return { values, conflicts };
}
