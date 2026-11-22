import { useRef, useState } from "react";
import { z } from "zod";

import { useRequirementAssociationActions, useRequirementLibrary } from "../requirement-library.js";
import { Button } from "../../../shared/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import "../../../styles/redesign-requirements.css";

type Library = NonNullable<ReturnType<typeof useRequirementLibrary>["data"]>;
export type LibraryRequirement = Library["requirements"][number];
export type UserAssociation = LibraryRequirement["associations"][number];
export interface WordingSnapshot {
  profileVersion: number | null;
  roles: Array<{ role_id: string; achievements: Array<{ achievement_id: string; baseline_variant_id: string; source_refs: Array<{ source_id: string; revision: number }> }> }>;
  variants: Array<{ variant_id: string; revision: number; achievement_id: string; text: string; status: string; approval_id: string | null; source_refs: Array<{ source_id: string; revision: number }> }>;
}

const profileRolesSchema = z.object({
  resume: z.object({ experience_entries: z.array(z.object({
    id: z.string().nullish(), company: z.string().nullish(), title: z.string().nullish(),
    date_range: z.string().nullish(), achievement_ids: z.array(z.string()).nullish(),
    bullets: z.array(z.string()).nullish(),
  }).passthrough()).optional() }).passthrough().optional(),
}).passthrough();

export interface AchievementChoice {
  roleId: string;
  achievementId: string;
  roleLabel: string;
  dateRange: string;
  text: string;
  sourceRefs: { source_id: string; revision: number }[];
  variants: WordingSnapshot["variants"];
}

/** Join saved identities only; text similarity never creates a relationship. */
export function achievementChoices(profile: unknown, wording: WordingSnapshot | undefined): AchievementChoice[] {
  if (!wording) return [];
  const result = profileRolesSchema.safeParse(profile);
  const entries = result.success ? result.data.resume?.experience_entries ?? [] : [];
  return wording.roles.flatMap((role) => {
    const entry = entries.find((item) => item.id === role.role_id);
    return role.achievements.map((achievement) => {
      const index = entry?.achievement_ids?.indexOf(achievement.achievement_id) ?? -1;
      const variants = wording.variants.filter((variant) => variant.achievement_id === achievement.achievement_id);
      const baseline = variants.find((variant) => variant.variant_id === achievement.baseline_variant_id);
      return {
        roleId: role.role_id,
        achievementId: achievement.achievement_id,
        roleLabel: [entry?.company, entry?.title].filter(Boolean).join(" · ") || "Saved experience",
        dateRange: entry?.date_range ?? "",
        text: (index >= 0 ? entry?.bullets?.[index] : undefined) ?? baseline?.text ?? "Achievement text unavailable",
        sourceRefs: achievement.source_refs,
        variants,
      };
    });
  });
}

function sentenceCase(value: string) {
  const text = value.replaceAll("_", " ");
  return text ? text[0]!.toLocaleUpperCase() + text.slice(1) : text;
}

export function requirementQualifierText(requirement: { category?: string | undefined; scope?: string | undefined; qualifiers?: { dimension: string; value: string }[] | undefined }) {
  if (requirement.category) return requirement.category === "skill" ? "Skill" : requirement.category === "professional_experience" ? "Professional experience"
    : requirement.category === "education" ? "Education" : requirement.category === "language" ? "Language" : sentenceCase(requirement.category);
  const scopes: Record<string, string> = {
    resume: "Capability or responsibility", eligibility: "Eligibility", logistics: "Logistics", employer_condition: "Employer condition",
  };
  return [requirement.scope ? scopes[requirement.scope] ?? sentenceCase(requirement.scope) : "Historical requirement",
    ...(requirement.qualifiers ?? []).map((qualifier) => `${sentenceCase(qualifier.dimension)}: ${qualifier.value}`)].join(" · ");
}

function wordingOptionLabel(library: Library, variant: AchievementChoice["variants"][number]) {
  const names = library.requirements.flatMap((requirement) => {
    const assignment = requirement.current_wordings.find((item) => item.achievement_id === variant.achievement_id
      && item.variant_id === variant.variant_id && item.variant_revision === variant.revision);
    const coverage = requirement.coverage.filter((item) => item.achievement_id === variant.achievement_id
      && item.variant_id === variant.variant_id && String(item.variant_revision) === String(variant.revision));
    const link = requirement.associations.find((item) => item.state === "active" && item.achievement_id === variant.achievement_id
      && item.wording?.variant_id === variant.variant_id && item.wording.variant_revision === variant.revision);
    if (!assignment && !coverage.length && !link) return [];
    const status = assignment ? assignment.current ? "current wording" : "current wording needs review"
      : coverage.some((item) => item.current && item.covered) ? "coverage recorded"
      : coverage.some((item) => item.current) ? "not covered" : link ? "your link, unassessed" : "earlier coverage";
    return [`${requirement.definition} (${status})`];
  });
  const context = names.length ? `${names.join("; ")} · ` : "";
  return `${context}${sentenceCase(variant.status)} · revision ${variant.revision} · Text: ${variant.text}`;
}

export function associationLabel(association: UserAssociation) {
  if (association.state === "removed") return association.current ? "Removed · unassessed" : "Removed · unassessed · needs review";
  return association.current ? "Your link · unassessed" : "Your link · unassessed · needs review";
}

export function AssociationStateAction({ association }: { association: UserAssociation }) {
  const actions = useRequirementAssociationActions();
  const mutation = association.state === "active" ? actions.remove : actions.restore;
  return <div className="requirement-association-action">
    <span className="requirement-badge">{associationLabel(association)}</span>
    <Button type="button" variant="ghost" size="sm" disabled={mutation.isPending}
      onClick={() => mutation.mutate({ associationId: association.association_id, expectedRevision: association.revision, profileId: association.profile_id })}>
      {mutation.isPending ? "Saving…" : association.state === "active" ? "Remove link" : "Restore link"}
    </Button>
    {mutation.error ? <p className="requirement-error" role="alert">{mutation.error.message} Reload the links and try again.</p> : null}
  </div>;
}

export function RequirementAssociationPicker({ library, choices, profileVersion, wordingProfileVersion, sourceLoading, sourceError, requirementId, achievementId, requireWording = false, onClose }: {
  library: Library;
  choices: AchievementChoice[];
  profileVersion: number | null | undefined;
  wordingProfileVersion: number | null | undefined;
  sourceLoading: boolean;
  sourceError?: string | undefined;
  requirementId?: string | undefined;
  achievementId?: string | undefined;
  requireWording?: boolean | undefined;
  onClose: () => void;
}) {
  const actions = useRequirementAssociationActions();
  const initialAssociation = library.requirements.find((item) => item.requirement_id === requirementId)?.associations
    .find((item) => item.achievement_id === achievementId && item.state === "active");
  const [selectedRequirement, setSelectedRequirement] = useState(requirementId ?? "");
  const [selectedAchievement, setSelectedAchievement] = useState(achievementId ?? "");
  const [selectedVariant, setSelectedVariant] = useState(initialAssociation?.wording?.variant_id ?? "");
  const [filter, setFilter] = useState("");
  const pendingRequest = useRef<{ key: string; id: string } | null>(null);
  const requirement = library.requirements.find((item) => item.requirement_id === selectedRequirement);
  const achievement = choices.find((item) => item.achievementId === selectedAchievement);
  const variant = achievement?.variants.find((item) => item.variant_id === selectedVariant);
  const needle = filter.trim().toLocaleLowerCase();
  const matchingRequirements = library.requirements.filter((item) => item.definition.toLocaleLowerCase().includes(needle));
  const matchingAchievements = choices.filter((item) => `${item.roleLabel}\n${item.text}`.toLocaleLowerCase().includes(needle));
  const ready = library.readiness === "ready" && library.profile_revision !== null
    && library.profile_revision === wordingProfileVersion
    && library.profile_revision === profileVersion && !sourceError;
  const existing = requirement?.associations.find((item) => item.state === "active" && item.achievement_id === achievement?.achievementId);
  const unchanged = existing?.current && (variant ? existing.wording?.variant_id === variant.variant_id && existing.wording.variant_revision === variant.revision : existing.wording === null);
  const valid = !!requirement && !!achievement && achievement.sourceRefs.length > 0 && ready
    && (!requireWording || !!variant) && !unchanged;
  const pending = actions.create.isPending || actions.revise.isPending;
  const selectRequirement = (id: string) => {
    setSelectedRequirement(id);
    setSelectedVariant(library.requirements.find((item) => item.requirement_id === id)?.associations
      .find((item) => item.achievement_id === selectedAchievement && item.state === "active")?.wording?.variant_id ?? "");
  };
  const selectAchievement = (id: string) => {
    setSelectedAchievement(id);
    setSelectedVariant(requirement?.associations.find((item) => item.achievement_id === id && item.state === "active")?.wording?.variant_id ?? "");
  };
  const save = async () => {
    if (!valid || !requirement || !achievement || library.profile_revision === null) return;
    const body = {
      profile_id: library.profile_id,
      expected_profile_revision: library.profile_revision,
      requirement_id: requirement.requirement_id,
      requirement_revision: requirement.revision,
      achievement_id: achievement.achievementId,
      achievement_source_refs: achievement.sourceRefs,
      wording: variant ? { variant_id: variant.variant_id, variant_revision: variant.revision,
        exact_text: variant.text, source_refs: variant.source_refs } : null,
    };
    const key = JSON.stringify(body);
    if (!existing && pendingRequest.current?.key !== key) pendingRequest.current = { key, id: actions.newAssociationId() };
    try {
      if (existing) await actions.revise.mutateAsync({ ...body, association_id: existing.association_id, expected_revision: existing.revision });
      else if (pendingRequest.current) await actions.create.mutateAsync({ ...body, association_id: pendingRequest.current.id });
      onClose();
    } catch {
      // Preserve the selection and, for creation, the request identity for reconciliation.
    }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
    <DialogContent className="requirement-picker">
      <DialogHeader><DialogTitle>{requireWording ? "Link a wording" : requirementId ? "Link an achievement" : "Link a requirement"}</DialogTitle>
        <DialogDescription>Record your intended association. It does not assess factual support or wording coverage.</DialogDescription></DialogHeader>
      {sourceError ? <p className="requirement-error" role="alert">Saved achievements could not be loaded. Reload the Profile and try again.</p> : null}
      {sourceLoading ? <p>Loading saved achievements…</p> : null}
      {!sourceLoading && !ready ? <p role="status">Save the Profile and reload these links before choosing an association.</p> : null}
      {requirementId ? <div><strong>Requirement</strong><p>{requirement?.definition ?? "This requirement is unavailable."}</p></div> : <div className="requirement-picker__section">
        <label>Find a requirement<Input value={filter} onChange={(event) => setFilter(event.currentTarget.value)} placeholder="Search saved definitions" /></label>
        <div className="requirement-picker__options" role="group" aria-label="Choose a requirement">
          {matchingRequirements.map((item) => <button type="button" key={item.requirement_id} aria-pressed={item.requirement_id === selectedRequirement} onClick={() => selectRequirement(item.requirement_id)}><strong>{item.definition}</strong><span>{requirementQualifierText(item)}</span></button>)}
          {!matchingRequirements.length ? <p>No saved definitions match.</p> : null}
        </div></div>}
      {achievementId ? <div><strong>Achievement</strong><p>{achievement?.text ?? "Save this achievement to link it."}</p>{achievement ? <p className="muted">{achievement.roleLabel}</p> : null}</div> : <div className="requirement-picker__section">
        <label>Find an achievement<Input value={filter} onChange={(event) => setFilter(event.currentTarget.value)} placeholder="Company, role or achievement" /></label>
        <div className="requirement-picker__options" role="group" aria-label="Choose an achievement">
          {matchingAchievements.map((item) => <button type="button" key={item.achievementId} aria-pressed={item.achievementId === selectedAchievement} onClick={() => selectAchievement(item.achievementId)}><strong>{item.roleLabel}</strong><span>{item.text}</span></button>)}
          {!matchingAchievements.length && !sourceLoading ? <p>No saved achievements match.</p> : null}
        </div></div>}
      {achievement ? <label className="requirement-picker__select">Specific wording {requireWording ? "" : "(optional)"}
        <select value={selectedVariant} onChange={(event) => setSelectedVariant(event.currentTarget.value)}>
          <option value="">{requireWording ? "Choose a wording" : "No specific wording"}</option>
          {achievement.variants.map((item) => <option key={`${item.variant_id}:${item.revision}`} value={item.variant_id}>{wordingOptionLabel(library, item)}</option>)}
        </select>
      </label> : null}
      {variant ? <div className="requirement-picker__wording"><strong>Exact wording to associate</strong><p>{variant.text}</p><span className="muted">{sentenceCase(variant.status)} · revision {variant.revision}</span></div> : null}
      {unchanged ? <p role="status">This exact association is already active.</p> : existing ? <p>Saving updates your existing unassessed link and retains its history.</p> : null}
      {achievement && !achievement.sourceRefs.length ? <p role="status">The achievement’s saved sources are unavailable. Reload the Profile before linking it.</p> : null}
      {actions.create.error || actions.revise.error ? <p className="requirement-error" role="alert">{(actions.create.error ?? actions.revise.error)?.message} Your selection is still here; reload if the saved inputs changed.</p> : null}
      <div className="requirement-picker__actions"><Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button><Button type="button" disabled={!valid || pending} onClick={() => void save()}>{pending ? "Saving…" : existing ? "Update link" : "Save link"}</Button></div>
    </DialogContent>
  </Dialog>;
}
