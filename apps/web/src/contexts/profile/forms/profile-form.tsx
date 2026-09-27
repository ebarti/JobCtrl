import {
  ProfileSchema,
  type ProfileShape,
  type ProfileUpdateRequest,
} from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ProfileConfigResponse,
  RequiredBulletSuggestion,
} from "../../operations/types.js";
import { Alert, AlertDescription } from "../../../shared/ui/alert.js";
import { Button } from "../../../shared/ui/button.js";
import { getPathValue, isJsonRecord, setPathValue, type JsonRecord } from "../lib/json-record.js";
import { StructuredProfileEditor } from "../components/StructuredProfileEditor.js";
import { RequiredBulletSuggestions } from "../components/RequiredBulletSuggestions.js";
import { TargetRoleSuggestions } from "../components/TargetRoleSuggestions.js";
import { useUpdateProfileMutation } from "../hooks/useUpdateProfileMutation.js";
import { AutosaveUndoController } from "../../../shared/ui/autosave-undo-controller.js";
import {
  isProfileDateRangeChronological,
  parseProfileDateRange,
} from "../lib/profile-date-fields.js";

export type ProfileSection = "profile" | "preferences" | "target-search";

export interface ProfileFormValues {
  profile: JsonRecord | null;
  style: JsonRecord | null;
  templateText: string;
}

export interface ProfileFormProps {
  initial: ProfileConfigResponse;
  onPlateTextControllerChange?: (controller: ProfilePlateTextController | null) => void;
  onPreviewSourceChange?: (profile: ProfileConfigResponse) => void;
  section?: ProfileSection;
  showSectionHeading?: boolean;
}

export interface ProfilePlateTextChange {
  readonly semanticId: string;
  readonly baselineTexts: readonly string[];
  readonly plateTexts: readonly string[];
}

export interface ProfilePlateTextController {
  readonly apply: (changes: readonly ProfilePlateTextChange[]) => void;
}

export function toProfileFormValues(profile: ProfileConfigResponse): ProfileFormValues {
  return {
    profile: isJsonRecord(profile.profile) ? profile.profile : null,
    style: isJsonRecord(profile.style) ? profile.style : null,
    templateText: profile.templateText,
  };
}

function validateProfileForm(values: ProfileFormValues): string | undefined {
  const profileResult = ProfileSchema.safeParse(values.profile);
  if (!profileResult.success) {
    return `Profile data: ${profileResult.error.issues[0]?.message ?? "invalid profile"}`;
  }
  const profileDateError = validateProfileDateRanges(profileResult.data);
  if (profileDateError) {
    return profileDateError;
  }
  if (!values.style) return "Resume style settings: expected an object";
  return undefined;
}

function validateProfileDateRanges(profile: ProfileShape): string | undefined {
  const entries = profile.resume.experience_entries;
  for (const [index, entry] of entries.entries()) {
    if (!isProfileDateRangeChronological(parseProfileDateRange(entry.date_range))) {
      const label = entry.title || `Experience ${index + 1}`;
      return `${label}: End date must be after start date.`;
    }
  }
  return undefined;
}

function toUpdateRequest(
  values: ProfileFormValues,
  expectedProfileVersion?: number,
): ProfileUpdateRequest {
  return {
    profileText: JSON.stringify(values.profile, null, 2),
    styleText: JSON.stringify(values.style, null, 2),
    templateText: values.templateText,
    ...(expectedProfileVersion === undefined ? {} : { expectedProfileVersion }),
  };
}

function setRequiredBulletText(
  profile: JsonRecord,
  experienceId: string,
  index: number,
  text: string,
): boolean {
  const required = getPathValue(profile, "resume.tailoring_rules.required_bullets_by_experience_id");
  if (!isJsonRecord(required) || !Object.hasOwn(required, experienceId)
    || !Array.isArray(required[experienceId])) return false;
  const bullets = required[experienceId] as unknown[];
  if (typeof bullets[index] !== "string") return false;
  bullets[index] = text;
  return true;
}

function ownRequiredBullets(profile: ProfileShape, experienceId: string): string[] | undefined {
  const pins = profile.resume.tailoring_rules.required_bullets_by_experience_id;
  return pins && Object.hasOwn(pins, experienceId) ? pins[experienceId] : undefined;
}

interface PendingRequiredPinConflict {
  readonly experienceId: string;
  readonly entryIndex: number;
  bulletIndex: number;
  requiredBulletIndex: number;
  previousText: string;
  baselineBullets: string[];
}

function reconcilePendingRequiredPin(
  profile: JsonRecord,
  conflict: PendingRequiredPinConflict,
): "resolved" | "updated" | "blocked" {
  const parsed = ProfileSchema.safeParse(profile);
  if (!parsed.success) return "blocked";
  const entries = parsed.data.resume.experience_entries;
  const entry = entries[conflict.entryIndex];
  if (!entry || entry.id !== conflict.experienceId || entries.filter((item) => item.id === entry.id).length !== 1) {
    return "blocked";
  }
  const required = ownRequiredBullets(parsed.data, entry.id);
  if (!required) {
    return "blocked";
  }
  const pinnedText = required[conflict.requiredBulletIndex];
  if (typeof pinnedText !== "string" || required.filter((item) => item === pinnedText).length !== 1) {
    return "blocked";
  }
  const matchingPinBulletIndexes = entry.bullets.flatMap((text, index) =>
    text === pinnedText ? [index] : []);
  // A pin is text-based. If its unique text moved, follow that occurrence
  // before considering the old position; the old position now belongs to a
  // different bullet and must never inherit the pin.
  if (matchingPinBulletIndexes.length === 1
    && (pinnedText === conflict.previousText || !required.includes(conflict.previousText))) {
    conflict.bulletIndex = matchingPinBulletIndexes[0]!;
    conflict.previousText = pinnedText;
    conflict.baselineBullets = [...entry.bullets];
    return "resolved";
  }
  if (matchingPinBulletIndexes.length > 1) return "blocked";
  const bullet = entry.bullets[conflict.bulletIndex];
  if (pinnedText !== conflict.previousText
    || !bullet
    || entry.bullets.filter((item) => item === bullet).length !== 1
    || entry.bullets.length !== conflict.baselineBullets.length
    || conflict.baselineBullets[conflict.bulletIndex] !== conflict.previousText
    || entry.bullets.some((text, index) =>
      index !== conflict.bulletIndex && text !== conflict.baselineBullets[index])
    || required.filter((item) => item === bullet).length > 1) {
    return "blocked";
  }
  if (required.includes(bullet)) {
    const requiredMap = getPathValue(profile, "resume.tailoring_rules.required_bullets_by_experience_id");
    if (!isJsonRecord(requiredMap) || !Object.hasOwn(requiredMap, entry.id)
      || !Array.isArray(requiredMap[entry.id])) return "blocked";
    const updatedRequired = requiredMap[entry.id] as unknown[];
    updatedRequired.splice(conflict.requiredBulletIndex, 1);
    conflict.requiredBulletIndex = updatedRequired.indexOf(bullet);
    conflict.previousText = bullet;
    conflict.baselineBullets = [...entry.bullets];
    return "updated";
  }
  if (!setRequiredBulletText(profile, entry.id, conflict.requiredBulletIndex, bullet)) return "blocked";
  conflict.previousText = bullet;
  conflict.baselineBullets = [...entry.bullets];
  return "updated";
}

function explicitlyRemovedRequiredPin(
  before: JsonRecord | null,
  after: JsonRecord,
  conflict: PendingRequiredPinConflict,
): boolean {
  const beforeMap = before && getPathValue(before, "resume.tailoring_rules.required_bullets_by_experience_id");
  const afterMap = getPathValue(after, "resume.tailoring_rules.required_bullets_by_experience_id");
  if (!isJsonRecord(beforeMap) || !isJsonRecord(afterMap)) return false;
  const oldPins = Object.hasOwn(beforeMap, conflict.experienceId)
    ? beforeMap[conflict.experienceId] : undefined;
  const newPins = Object.hasOwn(afterMap, conflict.experienceId)
    ? afterMap[conflict.experienceId] : undefined;
  return Array.isArray(oldPins) && Array.isArray(newPins)
    && oldPins[conflict.requiredBulletIndex] === conflict.previousText
    && newPins.length === oldPins.length - 1
    && !newPins.includes(conflict.previousText);
}

function appendTargetRoles(profile: JsonRecord | null, titles: readonly string[]): JsonRecord | null {
  if (!profile) return profile;
  const next = structuredClone(profile);
  const current = targetRoles(next);
  const seen = new Set(current.map((value) => value.toLowerCase()));
  for (const title of titles) {
    const trimmed = title.trim();
    const key = trimmed.toLowerCase();
    if (trimmed && !seen.has(key)) {
      current.push(trimmed);
      seen.add(key);
    }
  }
  setPathValue(next, "experience.target_role", current.join("; "));
  return next;
}

function targetRoles(profile: JsonRecord | null): string[] {
  return String(getPathValue(profile, "experience.target_role") ?? "")
    .split(/[;,\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

type TargetPreferenceRow = { location: string; workModel: string };

function targetPreferenceRows(profile: JsonRecord | null): TargetPreferenceRow[] {
  const splitRows = (path: string) => {
    const value = String(getPathValue(profile, path) ?? "");
    return value ? value.split(";").map((part) => part.trim()) : [];
  };
  const locations = splitRows("experience.target_locations");
  const models = splitRows("experience.target_work_models");
  return Array.from({ length: Math.max(locations.length, models.length) }, (_, index) => ({
    location: locations[index] ?? "",
    workModel: models[index] ?? "",
  }));
}

function preferenceRowKey(row: TargetPreferenceRow): string {
  return `${row.location.trim().toLowerCase()}\u0000${row.workModel.trim().toLowerCase()}`;
}

function writeTargetPreferenceRows(profile: JsonRecord, rows: readonly TargetPreferenceRow[]): void {
  setPathValue(profile, "experience.target_locations", rows.map((row) => row.location).join("; "));
  setPathValue(profile, "experience.target_work_models", rows.map((row) => row.workModel).join("; "));
}

function appendTargetPreferences(
  profile: JsonRecord | null,
  proposals: readonly TargetPreferenceRow[],
): JsonRecord | null {
  if (!profile) return profile;
  const next = structuredClone(profile);
  const rows = targetPreferenceRows(next);
  const seen = new Set(rows.map(preferenceRowKey));
  for (const proposal of proposals) {
    const row = { location: proposal.location.trim(), workModel: proposal.workModel.trim() };
    const key = preferenceRowKey(row);
    if ((row.location || row.workModel) && !seen.has(key)) {
      rows.push(row);
      seen.add(key);
    }
  }
  writeTargetPreferenceRows(next, rows);
  return next;
}

function omitTargetPreferences(
  profile: JsonRecord | null,
  proposals: readonly TargetPreferenceRow[],
): JsonRecord | null {
  if (!profile || proposals.length === 0) return profile;
  const omitted = new Set(proposals.map(preferenceRowKey));
  const next = structuredClone(profile);
  writeTargetPreferenceRows(next, targetPreferenceRows(next).filter((row) => !omitted.has(preferenceRowKey(row))));
  return next;
}

function omitTargetRoles(profile: JsonRecord | null, titles: readonly string[]): JsonRecord | null {
  if (!profile || titles.length === 0) return profile;
  const omitted = new Set(titles.map((title) => title.trim().toLowerCase()));
  const next = structuredClone(profile);
  const current = targetRoles(next).filter((title) => !omitted.has(title.toLowerCase()));
  setPathValue(next, "experience.target_role", current.join("; "));
  return next;
}

function serializeProfileValues(values: ProfileFormValues): string {
  return JSON.stringify(values);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (isJsonRecord(left) || isJsonRecord(right)) {
    if (!isJsonRecord(left) || !isJsonRecord(right)) return false;
    const leftKeys = Object.keys(left).toSorted();
    const rightKeys = Object.keys(right).toSorted();
    return jsonValuesEqual(leftKeys, rightKeys)
      && leftKeys.every((key) => jsonValuesEqual(left[key], right[key]));
  }
  return false;
}

interface ProfileRebaseResult {
  readonly conflicts: readonly string[];
  readonly value: unknown;
}

function rebaseIndexedTextArray(
  base: readonly unknown[],
  local: readonly unknown[],
  remote: readonly unknown[],
  path: string,
): ProfileRebaseResult {
  const isUniqueText = (items: readonly unknown[]): items is readonly string[] =>
    items.every((item) => typeof item === "string")
    && new Set(items).size === items.length;
  if (base.length !== local.length || base.length !== remote.length
    || !isUniqueText(base) || !isUniqueText(local) || !isUniqueText(remote)) {
    return { conflicts: [path], value: structuredClone(local) };
  }
  const originalIndexes = new Map(base.map((text, index) => [text, index]));
  const movedOriginal = (items: readonly string[]) => items.some(
    (text, index) => originalIndexes.has(text) && originalIndexes.get(text) !== index,
  );
  if (movedOriginal(local) || movedOriginal(remote)) {
    return { conflicts: [path], value: structuredClone(local) };
  }
  const merged = base.map((text, index) => rebaseProfileValue(
    text, local[index], remote[index], `${path}[${index}]`,
  ));
  const conflicts = merged.flatMap((item) => item.conflicts);
  const value = merged.map((item) => item.value);
  if (new Set(value).size !== value.length) conflicts.push(path);
  return { conflicts, value };
}

function rebaseExperienceEntries(
  base: readonly unknown[],
  local: readonly unknown[],
  remote: readonly unknown[],
  path: string,
): ProfileRebaseResult {
  const ids = (items: readonly unknown[]): string[] | null => {
    const result = items.map((item) => isJsonRecord(item) ? item.id : undefined);
    return result.every((id) => typeof id === "string" && id.length > 0)
      && new Set(result).size === result.length ? result as string[] : null;
  };
  const baseIds = ids(base);
  if (!baseIds || !jsonValuesEqual(ids(local), baseIds) || !jsonValuesEqual(ids(remote), baseIds)) {
    return { conflicts: [path], value: structuredClone(local) };
  }
  const merged = base.map((entry, index) => rebaseProfileValue(
    entry, local[index], remote[index], `${path}[${baseIds[index]}]`,
  ));
  return {
    conflicts: merged.flatMap((item) => item.conflicts),
    value: merged.map((item) => item.value),
  };
}

function rebaseProfileValue(
  base: unknown,
  local: unknown,
  remote: unknown,
  path = "profile",
): ProfileRebaseResult {
  if (jsonValuesEqual(local, base)) return { conflicts: [], value: structuredClone(remote) };
  if (jsonValuesEqual(remote, base) || jsonValuesEqual(local, remote)) {
    return { conflicts: [], value: structuredClone(local) };
  }
  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
    if (path === "form.profile.resume.experience_entries") {
      return rebaseExperienceEntries(base, local, remote, path);
    }
    if ((path.startsWith("form.profile.resume.experience_entries[") && path.endsWith("].bullets"))
      || path.startsWith("form.profile.resume.tailoring_rules.required_bullets_by_experience_id.")) {
      return rebaseIndexedTextArray(base, local, remote, path);
    }
  }
  if (isJsonRecord(base) && isJsonRecord(local) && isJsonRecord(remote)) {
    const value = Object.create(null) as JsonRecord;
    const conflicts: string[] = [];
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
      const rebased = rebaseProfileValue(
        Object.hasOwn(base, key) ? base[key] : undefined,
        Object.hasOwn(local, key) ? local[key] : undefined,
        Object.hasOwn(remote, key) ? remote[key] : undefined,
        `${path}.${key}`,
      );
      if (rebased.value !== undefined) value[key] = rebased.value;
      conflicts.push(...rebased.conflicts);
    }
    return { conflicts, value };
  }
  return { conflicts: [path], value: structuredClone(local) };
}

interface AppliedPlateTarget {
  readonly bulletIndex?: number;
  readonly skillItemIndex?: number;
  readonly skillItems?: readonly string[];
  readonly skillItemWasUnique?: boolean;
  readonly texts: readonly string[];
}

interface PlateProfileProjectionState {
  readonly activeChanges: ReadonlyMap<string, ProfilePlateTextChange>;
  readonly appliedTargets: ReadonlyMap<string, AppliedPlateTarget>;
}

interface PlateProfileProjectionResult {
  readonly conflictCount: number;
  readonly unmappedCount: number;
  readonly profile: JsonRecord | null;
  readonly state: PlateProfileProjectionState;
}

function normalizedPlateText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function plateTextArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (text, index) => normalizedPlateText(text) === normalizedPlateText(right[index] ?? ""),
    )
  );
}

function matchingTextSequenceIndexes(
  values: readonly string[],
  sequence: readonly string[],
): number[] {
  if (!sequence.length || sequence.length > values.length) return [];
  const matches: number[] = [];
  for (let index = 0; index <= values.length - sequence.length; index += 1) {
    if (plateTextArraysEqual(values.slice(index, index + sequence.length), sequence)) {
      matches.push(index);
    }
  }
  return matches;
}

function profileWithPlateChanges(
  profileDraft: JsonRecord | null,
  changes: readonly ProfilePlateTextChange[],
  previousState: PlateProfileProjectionState | null,
): PlateProfileProjectionResult {
  const activeChanges = new Map(changes.map((change) => [change.semanticId, change]));
  const appliedTargets = new Map(previousState?.appliedTargets ?? []);
  const unchangedResult = (conflictCount = 0): PlateProfileProjectionResult => ({
    conflictCount,
    unmappedCount: 0,
    profile: profileDraft,
    state: { activeChanges, appliedTargets },
  });
  if (!profileDraft) return unchangedResult(changes.length);

  // A draft can temporarily contain an empty required title or invalid number.
  // Check the targeted structure here; validate the complete profile on save.
  const updatedProfile = structuredClone(profileDraft);
  const readText = (path: string): string | null => {
    const value = getPathValue(updatedProfile, path);
    return value == null ? "" : typeof value === "string" ? value : null;
  };
  const findEntry = (path: string, id: string | undefined): { entry: JsonRecord; index: number } | undefined => {
    const entries = getPathValue(updatedProfile, path);
    if (!Array.isArray(entries)) return undefined;
    const matches = entries.flatMap((entry, index) => isJsonRecord(entry) && entry["id"] === id ? [{ entry, index }] : []);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const isTextArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
  let changed = false;
  let conflictCount = 0;
  let unmappedCount = 0;
  const appliedSkillItems = new Map<string, { items: string[]; index: number }>();
  const effectiveChanges = [...activeChanges.values()];
  for (const [semanticId, previousChange] of previousState?.activeChanges ?? []) {
    if (
      !activeChanges.has(semanticId) &&
      previousState?.appliedTargets.has(semanticId)
    ) {
      effectiveChanges.push({
        semanticId,
        baselineTexts: previousChange.baselineTexts,
        plateTexts: previousChange.baselineTexts,
      });
    }
  }

  const applySingleText = (
    change: ProfilePlateTextChange,
    current: string | null,
    update: (value: string) => void,
  ): void => {
    if (current === null) {
      appliedTargets.delete(change.semanticId);
      conflictCount += 1;
      return;
    }
    const previousTarget = appliedTargets.get(change.semanticId);
    const expectedTexts = previousTarget?.texts ?? change.baselineTexts;
    const desiredText = normalizedPlateText(change.plateTexts.join(" "));
    const currentTexts = [current];
    const desiredTexts = [desiredText];
    const matchesExpected = plateTextArraysEqual(currentTexts, expectedTexts);
    const alreadyDesired = plateTextArraysEqual(currentTexts, desiredTexts);
    if (!matchesExpected && !alreadyDesired) {
      appliedTargets.delete(change.semanticId);
      conflictCount += 1;
      return;
    }
    if (current !== desiredText) {
      update(desiredText);
      changed = true;
    }
    if (activeChanges.has(change.semanticId)) {
      appliedTargets.set(change.semanticId, { texts: desiredTexts });
    } else {
      appliedTargets.delete(change.semanticId);
    }
  };

  for (const change of effectiveChanges) {
    const personalMatch = /^personal:(full_name|address|city|postal_code|country|email|phone)$/.exec(change.semanticId);
    if (personalMatch) {
      const key = personalMatch[1]!;
      applySingleText(change, readText(`personal.${key}`), (value) => {
        setPathValue(updatedProfile, `personal.${key}`, value);
      });
      continue;
    }
    if (change.semanticId === "summary") {
      applySingleText(
        change,
        readText("resume.executive_profile.baseline_text"),
        (value) => {
          setPathValue(updatedProfile, "resume.executive_profile.baseline_text", value);
        },
      );
      continue;
    }

    const experienceMatch = /^experience:(.+):(title|company|location|date_range|summary)$/.exec(change.semanticId);
    if (experienceMatch) {
      const target = findEntry("resume.experience_entries", experienceMatch[1]);
      if (!target) {
        appliedTargets.delete(change.semanticId);
        conflictCount += 1;
        continue;
      }
      const key = experienceMatch[2] as "title" | "company" | "location" | "date_range" | "summary";
      const path = `resume.experience_entries.${target.index}.${key}`;
      applySingleText(change, readText(path), (value) => {
        setPathValue(updatedProfile, path, value);
      });
      continue;
    }

    const educationMatch = /^education:(.+):(degree|institution|location|date)$/.exec(change.semanticId);
    if (educationMatch) {
      const target = findEntry("resume.education_entries", educationMatch[1]);
      if (!target) {
        appliedTargets.delete(change.semanticId);
        conflictCount += 1;
        continue;
      }
      const key = educationMatch[2] as "degree" | "institution" | "location" | "date";
      const path = `resume.education_entries.${target.index}.${key}`;
      applySingleText(change, readText(path), (value) => {
        setPathValue(updatedProfile, path, value);
      });
      continue;
    }

    const skillMatch = /^skills:(.+):(label|item:([1-9]\d*))$/.exec(change.semanticId);
    if (skillMatch) {
      const target = findEntry("resume.skill_categories", skillMatch[1]);
      if (!target) {
        appliedTargets.delete(change.semanticId);
        conflictCount += 1;
        continue;
      }
      const prefix = `resume.skill_categories.${target.index}`;
      if (skillMatch[2] === "label") {
        applySingleText(change, readText(`${prefix}.label`), (value) => setPathValue(updatedProfile, `${prefix}.label`, value));
      } else {
        const items = target.entry["items"];
        if (!isTextArray(items)) {
          appliedTargets.delete(change.semanticId);
          conflictCount += 1;
          continue;
        }
        const previousTarget = appliedTargets.get(change.semanticId);
        const expected = previousTarget?.texts ?? change.baselineTexts;
        const indexes = matchingTextSequenceIndexes(items, expected);
        const previousIndex = previousTarget?.skillItemIndex;
        const incomingItems = getPathValue(profileDraft, `${prefix}.items`);
        // Keep following an edit through transient duplicates. If that item was
        // changed elsewhere, a remaining duplicate is not its replacement.
        const index = previousIndex !== undefined && isTextArray(incomingItems) &&
          plateTextArraysEqual(incomingItems, previousTarget?.skillItems ?? []) &&
          plateTextArraysEqual(items.slice(previousIndex, previousIndex + 1), expected)
          ? previousIndex
          : indexes.length === 1 && previousTarget?.skillItemWasUnique !== false
            ? indexes[0]
            : undefined;
        if (index === undefined) {
          appliedTargets.delete(change.semanticId);
          conflictCount += 1;
          continue;
        }
        applySingleText(change, items[index] ?? "", (value) => {
          items[index] = value;
          setPathValue(updatedProfile, `${prefix}.items`, items);
        });
        appliedSkillItems.set(change.semanticId, { items, index });
      }
      continue;
    }

    if (change.semanticId.startsWith("unmapped:")) {
      unmappedCount += 1;
      continue;
    }

    const bulletMatch = /^experience:(.+):bullet:([1-9]\d*)$/.exec(
      change.semanticId,
    );
    if (bulletMatch) {
      const entryId = bulletMatch[1];
      const bulletOrdinal = bulletMatch[2];
      if (!entryId || !bulletOrdinal) continue;
      const target = findEntry("resume.experience_entries", entryId);
      const bullets = target?.entry["bullets"];
      if (!target || !isTextArray(bullets)) {
        appliedTargets.delete(change.semanticId);
        conflictCount += 1;
        continue;
      }
      const previousTarget = appliedTargets.get(change.semanticId);
      const expectedTexts = previousTarget?.texts ?? change.baselineTexts;
      const desiredTexts = change.plateTexts
        .map(normalizedPlateText)
        .filter(Boolean);
      let bulletIndex: number | null = null;
      if (
        previousTarget?.bulletIndex !== undefined &&
        plateTextArraysEqual(
          bullets.slice(
            previousTarget.bulletIndex,
            previousTarget.bulletIndex + expectedTexts.length,
          ),
          expectedTexts,
        )
      ) {
        bulletIndex = previousTarget.bulletIndex;
      } else {
        const matches = matchingTextSequenceIndexes(bullets, expectedTexts);
        if (matches.length === 1) {
          bulletIndex = matches[0] ?? null;
        }
      }
      if (bulletIndex === null) {
        appliedTargets.delete(change.semanticId);
        conflictCount += 1;
        continue;
      }
      const currentTexts = bullets.slice(
        bulletIndex,
        bulletIndex + expectedTexts.length,
      );
      if (!plateTextArraysEqual(currentTexts, desiredTexts)) {
        bullets.splice(bulletIndex, expectedTexts.length, ...desiredTexts);
        setPathValue(updatedProfile, `resume.experience_entries.${target.index}.bullets`, bullets);
        changed = true;
      }
      if (activeChanges.has(change.semanticId)) {
        appliedTargets.set(change.semanticId, {
          bulletIndex,
          texts: desiredTexts,
        });
      } else {
        appliedTargets.delete(change.semanticId);
      }
    }
  }

  // All edits in this projection share the resulting snapshot. Capturing it
  // mid-pass would mistake a sibling preview edit for a later boxed change.
  for (const [semanticId, { items, index }] of appliedSkillItems) {
    const appliedTarget = appliedTargets.get(semanticId);
    if (appliedTarget) {
      appliedTargets.set(semanticId, {
        ...appliedTarget,
        skillItemIndex: index,
        skillItems: [...items],
        skillItemWasUnique: matchingTextSequenceIndexes(items, appliedTarget.texts).length === 1,
      });
    }
  }

  return {
    conflictCount,
    unmappedCount,
    profile: changed ? updatedProfile : profileDraft,
    state: { activeChanges, appliedTargets },
  };
}

export function ProfileForm({
  initial,
  onPlateTextControllerChange,
  onPreviewSourceChange,
  section = "profile",
  showSectionHeading = true,
}: ProfileFormProps) {
  const updateProfile = useUpdateProfileMutation();
  const [statusMessage, setStatusMessage] = useState("");
  const [statusTone, setStatusTone] = useState<"saved" | "warning">("saved");
  const [resetToken, setResetToken] = useState(0);
  const [formBaseVersion, setFormBaseVersion] = useState(initial.profileVersion);
  const formBaseVersionRef = useRef(formBaseVersion);
  formBaseVersionRef.current = formBaseVersion;
  const [suggestionDerivedDraft, setSuggestionDerivedDraft] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const formBaseResponseRef = useRef<ProfileConfigResponse>(initial);
  const formBaseValuesRef = useRef<ProfileFormValues>(structuredClone(toProfileFormValues(initial)));
  const suggestionAddedRolesRef = useRef<readonly {
    profileVersion: number;
    title: string;
  }[]>([]);
  const suggestionAddedPreferencesRef = useRef<readonly (TargetPreferenceRow & {
    profileVersion: number;
  })[]>([]);
  const suggestionReviewRequiredRef = useRef(false);
  const suggestionReviewResolvedVersionRef = useRef<number | undefined>(undefined);
  const plateProfileProjectionRef = useRef<PlateProfileProjectionState | null>(null);
  const expectedProfileVersionRef = useRef<number | undefined>(undefined);
  const requiredAcceptPendingRef = useRef(false);
  const profileSaveVersionFenceRef = useRef<number | undefined>(undefined);
  const requiredPinConflictRef = useRef<PendingRequiredPinConflict | null>(null);
  const isProfileSection = section === "profile";
  const saveLabel = "Save changes";
  const discardLabel = "Discard changes";
  const savedMessage =
    section === "profile"
      ? "Profile saved"
      : section === "target-search"
        ? "Discovery settings saved"
        : "Preferences saved";

  const clearTransientStatus = useCallback(() => {
    setStatusMessage("");
    setStatusTone("saved");
    if (updateProfile.error) {
      updateProfile.reset();
    }
  }, [updateProfile.error, updateProfile.reset]);

  const reconcileSuggestionProvenance = useCallback((profile: JsonRecord | null) => {
    const baseProfile = formBaseValuesRef.current.profile;
    if (jsonValuesEqual(targetRoles(profile), targetRoles(baseProfile))) {
      suggestionAddedRolesRef.current = [];
    }
    if (jsonValuesEqual(targetPreferenceRows(profile), targetPreferenceRows(baseProfile))) {
      suggestionAddedPreferencesRef.current = [];
    }
    if (
      suggestionAddedRolesRef.current.length === 0
      && suggestionAddedPreferencesRef.current.length === 0
      && !suggestionReviewRequiredRef.current
      && suggestionReviewResolvedVersionRef.current === undefined
    ) {
      expectedProfileVersionRef.current = undefined;
      setSuggestionDerivedDraft(false);
    }
    return {
      roles: suggestionAddedRolesRef.current,
      preferences: suggestionAddedPreferencesRef.current,
    };
  }, []);

  const form = useForm({
    // TanStack Form reapplies changed defaults to a clean form during render.
    // The saved form base can be newer than the query after an accepted edit,
    // so the query snapshot must not put the old bullet back into the draft.
    defaultValues: formBaseValuesRef.current,
    validators: {
      onBlur: ({ value }) => validateProfileForm(value),
      onSubmit: ({ value }) => validateProfileForm(value),
    },
    onSubmit: async ({ value, formApi }) => {
      if (requiredAcceptPendingRef.current) {
        setStatusTone("warning");
        setStatusMessage("Wait for the Required bullet save to finish. Your manual edits remain pending.");
        return;
      }
      if ((initial.profileVersion !== null
          && (formBaseVersion === null || initial.profileVersion > formBaseVersion))
        || (profileSaveVersionFenceRef.current !== undefined
          && profileSaveVersionFenceRef.current !== formBaseVersion)) {
        setStatusTone("warning");
        setStatusMessage("The saved profile changed. Rebase your manual edits before saving.");
        return;
      }
      if (requiredPinConflictRef.current && value.profile) {
        const correctedProfile = structuredClone(value.profile);
        const pinStatus = reconcilePendingRequiredPin(correctedProfile, requiredPinConflictRef.current);
        if (pinStatus === "blocked") {
          setStatusTone("warning");
          setStatusMessage("The edited Required bullet has an ambiguous pin. Make its text unique or discard the draft before saving.");
          return;
        }
        if (pinStatus === "updated") {
          const bullet = getPathValue(correctedProfile,
            `resume.experience_entries.${requiredPinConflictRef.current.entryIndex}.bullets.${requiredPinConflictRef.current.bulletIndex}`);
          if (typeof bullet === "string") {
            requiredPinConflictRef.current = { ...requiredPinConflictRef.current, previousText: bullet };
          }
          formApi.setFieldValue("profile", correctedProfile);
          setStatusTone("warning");
          setStatusMessage("The Required pin now follows your edited bullet. Review it and save again.");
          return;
        }
      }
      setStatusMessage("");
      const submittedSuggestions = reconcileSuggestionProvenance(value.profile);
      const requiresSuggestionAuthority =
        submittedSuggestions.roles.length > 0
        || submittedSuggestions.preferences.length > 0
        || suggestionReviewRequiredRef.current
        || suggestionReviewResolvedVersionRef.current !== undefined;
      if (
        requiresSuggestionAuthority
        && (
          expectedProfileVersionRef.current === undefined
          || formBaseVersion !== initial.profileVersion
        )
      ) {
        setStatusTone("warning");
        setStatusMessage(
          "The saved profile changed. Rebase this draft, regenerate suggestions, and review them before saving.",
        );
        return;
      }
      const submittedValues = serializeProfileValues(value);
      const shouldUpdateProfile =
        submittedValues !== serializeProfileValues(formBaseValuesRef.current);
      let profileResponse = formBaseResponseRef.current;
      if (shouldUpdateProfile) {
        try {
          profileResponse = await updateProfile.mutateAsync(
            // Every full-profile edit is conditional on the snapshot that
            // actually supplied this form. A new profile has no version yet.
            toUpdateRequest(value, formBaseVersion ?? undefined),
          );
        } catch {
          // The mutation owns the displayed error and rollback. Keep the local
          // form/base authority unchanged until a refreshed profile is rebased.
          return;
        }
      }
      if (shouldUpdateProfile) {
        profileSaveVersionFenceRef.current = profileResponse.profileVersion ?? profileSaveVersionFenceRef.current;
      }
      if (serializeProfileValues(formApi.state.values) === submittedValues) {
        expectedProfileVersionRef.current = undefined;
        requiredPinConflictRef.current = null;
        formBaseResponseRef.current = profileResponse;
        formBaseValuesRef.current = structuredClone(toProfileFormValues(profileResponse));
        suggestionAddedRolesRef.current = [];
        suggestionAddedPreferencesRef.current = [];
        suggestionReviewRequiredRef.current = false;
        suggestionReviewResolvedVersionRef.current = undefined;
        setFormBaseVersion(profileResponse.profileVersion);
        setSuggestionDerivedDraft(false);
        plateProfileProjectionRef.current = null;
        formApi.reset(toProfileFormValues(profileResponse));
        onPreviewSourceChange?.(profileResponse);
        setStatusTone("saved");
        setStatusMessage(savedMessage);
      } else {
        formBaseResponseRef.current = profileResponse;
        formBaseValuesRef.current = structuredClone(toProfileFormValues(profileResponse));
        reconcileSuggestionProvenance(formApi.state.values.profile);
        const submittedSuggestionKeys = new Set(
          submittedSuggestions.roles.map(({ title }) => title.toLowerCase()),
        );
        suggestionAddedRolesRef.current = suggestionAddedRolesRef.current.filter(
          ({ title }) => !submittedSuggestionKeys.has(title.toLowerCase()),
        );
        const submittedPreferenceKeys = new Set(
          submittedSuggestions.preferences.map(preferenceRowKey),
        );
        suggestionAddedPreferencesRef.current = suggestionAddedPreferencesRef.current.filter(
          (row) => !submittedPreferenceKeys.has(preferenceRowKey(row)),
        );
        setFormBaseVersion(profileResponse.profileVersion);
        const staleSuggestionRoles = suggestionAddedRolesRef.current.filter(
          ({ profileVersion }) => profileVersion !== profileResponse.profileVersion,
        );
        const staleSuggestionPreferences = suggestionAddedPreferencesRef.current.filter(
          ({ profileVersion }) => profileVersion !== profileResponse.profileVersion,
        );
        if (staleSuggestionRoles.length > 0 || staleSuggestionPreferences.length > 0) {
          const currentProfile = formApi.state.values.profile;
          const currentRoles = new Set(targetRoles(currentProfile).map((title) => title.toLowerCase()));
          const currentPreferences = new Set(targetPreferenceRows(currentProfile).map(preferenceRowKey));
          const editedStaleSuggestion =
            staleSuggestionRoles.some(({ title }) => !currentRoles.has(title.toLowerCase()))
            || staleSuggestionPreferences.some((row) => !currentPreferences.has(preferenceRowKey(row)));
          const cleanedProfile = omitTargetPreferences(
            omitTargetRoles(currentProfile, staleSuggestionRoles.map(({ title }) => title)),
            staleSuggestionPreferences,
          );
          suggestionAddedRolesRef.current = editedStaleSuggestion ? staleSuggestionRoles : [];
          suggestionAddedPreferencesRef.current = editedStaleSuggestion ? staleSuggestionPreferences : [];
          suggestionReviewRequiredRef.current = true;
          suggestionReviewResolvedVersionRef.current = undefined;
          expectedProfileVersionRef.current = undefined;
          setSuggestionDerivedDraft(true);
          if (!jsonValuesEqual(cleanedProfile, currentProfile)) {
            formApi.setFieldValue("profile", cleanedProfile);
          }
          setStatusTone("warning");
          setStatusMessage(
            editedStaleSuggestion
              ? "Saved; newer changes pending. An edited stale suggestion must be discarded or restored before rebasing."
              : "Saved; newer changes pending. Stale suggestions were removed; regenerate and review them before saving.",
          );
          return;
        }
        suggestionReviewRequiredRef.current = false;
        suggestionReviewResolvedVersionRef.current = undefined;
        if (suggestionAddedRolesRef.current.length > 0 || suggestionAddedPreferencesRef.current.length > 0) {
          expectedProfileVersionRef.current = (
            suggestionAddedRolesRef.current[0] ?? suggestionAddedPreferencesRef.current[0]
          )?.profileVersion;
          setSuggestionDerivedDraft(true);
        } else {
          expectedProfileVersionRef.current = undefined;
          setSuggestionDerivedDraft(false);
        }
        setStatusTone("warning");
        setStatusMessage("Saved; newer changes pending");
      }
    },
  });

  const applyPlateTextChanges = useCallback(
    (changes: readonly ProfilePlateTextChange[]) => {
      const currentProfile = form.state.values.profile;
      const projection = profileWithPlateChanges(
        currentProfile,
        changes,
        plateProfileProjectionRef.current,
      );
      plateProfileProjectionRef.current = projection.state;
      if (projection.conflictCount > 0 || projection.unmappedCount > 0) {
        setStatusTone("warning");
        setStatusMessage([
          ...(projection.conflictCount > 0 ? ["Some resume editor changes were not applied because the matching Profile data changed. Save or discard those Profile changes, then reopen the resume editor."] : []),
          ...(projection.unmappedCount > 0 ? ["Some parts of the preview cannot be edited here. Edit those fields in Profile data instead."] : []),
        ].join(" "));
      } else {
        clearTransientStatus();
      }
      if (projection.profile !== currentProfile) {
        form.setFieldValue("profile", projection.profile);
      }
    },
    [clearTransientStatus, form],
  );

  useEffect(() => {
    if (!onPlateTextControllerChange) return;
    onPlateTextControllerChange({ apply: applyPlateTextChanges });
    return () => onPlateTextControllerChange(null);
  }, [applyPlateTextChanges, onPlateTextControllerChange]);

  useEffect(() => {
    const savedFence = profileSaveVersionFenceRef.current;
    // Any successful save can be newer than the query while refetch is
    // pending. A failed accept can also roll its optimistic query patch back
    // at the same version. Neither snapshot should replace the known form base
    // or clear the version fence/reviewed suggestion.
    if (savedFence !== undefined
      && (initial.profileVersion === null || initial.profileVersion <= savedFence)) {
      return;
    }
    if (requiredAcceptPendingRef.current || form.state.isDirty || form.state.isSubmitting) {
      return;
    }
    plateProfileProjectionRef.current = null;
    expectedProfileVersionRef.current = undefined;
    profileSaveVersionFenceRef.current = undefined;
    requiredPinConflictRef.current = null;
    const initialValues = toProfileFormValues(initial);
    formBaseResponseRef.current = initial;
    formBaseValuesRef.current = structuredClone(initialValues);
    setFormBaseVersion(initial.profileVersion);
    setSuggestionDerivedDraft(false);
    suggestionAddedRolesRef.current = [];
    suggestionAddedPreferencesRef.current = [];
    suggestionReviewRequiredRef.current = false;
    suggestionReviewResolvedVersionRef.current = undefined;
    form.reset(initialValues);
    onPreviewSourceChange?.(initial);
    setResetToken((token) => token + 1);
  }, [form, initial, onPreviewSourceChange]);

  const rebaseOntoSavedProfile = useCallback(() => {
    if (initial.profileVersion === null
      || (formBaseVersionRef.current !== null
        && initial.profileVersion <= formBaseVersionRef.current)) {
      setStatusTone("warning");
      setStatusMessage("Wait for a newer saved profile before rebasing this draft.");
      return;
    }
    const remoteValues = toProfileFormValues(initial);
    const localValues = structuredClone(form.state.values);
    const trackedSuggestions = reconcileSuggestionProvenance(localValues.profile);
    const localRoles = new Set(targetRoles(localValues.profile).map((title) => title.toLowerCase()));
    const localPreferences = new Set(targetPreferenceRows(localValues.profile).map(preferenceRowKey));
    if (
      trackedSuggestions.roles.some(({ title }) => !localRoles.has(title.toLowerCase()))
      || trackedSuggestions.preferences.some((row) => !localPreferences.has(preferenceRowKey(row)))
    ) {
      setStatusTone("warning");
      setStatusMessage(
        "An accepted suggestion was edited in this stale draft. Discard the draft or restore that suggestion before rebasing.",
      );
      return;
    }
    const requiresSuggestionReview =
      trackedSuggestions.roles.length > 0
      || trackedSuggestions.preferences.length > 0
      || suggestionReviewRequiredRef.current;
    localValues.profile = omitTargetPreferences(
      omitTargetRoles(
        localValues.profile,
        trackedSuggestions.roles.map(({ title }) => title),
      ),
      trackedSuggestions.preferences,
    );
    const rebased = rebaseProfileValue(
      formBaseValuesRef.current,
      localValues,
      remoteValues,
      "form",
    );
    if (rebased.conflicts.length > 0) {
      setStatusTone("warning");
      setStatusMessage(
        `Saved and local edits overlap at ${rebased.conflicts.slice(0, 3).join(", ")}. `
          + "Discard or resolve those fields before requesting new suggestions.",
      );
      return;
    }
    const rebasedValues = rebased.value as ProfileFormValues;
    formBaseResponseRef.current = initial;
    formBaseValuesRef.current = structuredClone(remoteValues);
    suggestionAddedRolesRef.current = [];
    suggestionAddedPreferencesRef.current = [];
    suggestionReviewRequiredRef.current = requiresSuggestionReview;
    suggestionReviewResolvedVersionRef.current = undefined;
    setFormBaseVersion(initial.profileVersion);
    expectedProfileVersionRef.current = undefined;
    if (profileSaveVersionFenceRef.current !== undefined) {
      profileSaveVersionFenceRef.current = initial.profileVersion ?? undefined;
    }
    form.reset(remoteValues);
    if (!jsonValuesEqual(rebasedValues.profile, remoteValues.profile)) {
      form.setFieldValue("profile", rebasedValues.profile);
    }
    if (!jsonValuesEqual(rebasedValues.style, remoteValues.style)) {
      form.setFieldValue("style", rebasedValues.style);
    }
    if (rebasedValues.templateText !== remoteValues.templateText) {
      form.setFieldValue("templateText", rebasedValues.templateText);
    }
    setStatusTone("warning");
    setStatusMessage(
      requiresSuggestionReview
        ? "Draft rebased and stale suggestions removed. Regenerate and review suggestions before saving."
        : "Draft rebased onto the latest saved profile.",
    );
  }, [form, initial, reconcileSuggestionProvenance]);

  const rebaseProfileDraft = useCallback(() => {
    if (initial.profileVersion === null
      || (formBaseVersionRef.current !== null
        && initial.profileVersion <= formBaseVersionRef.current)) {
      setStatusTone("warning");
      setStatusMessage("Wait for a newer saved profile before rebasing this draft.");
      return;
    }
    const remoteValues = toProfileFormValues(initial);
    const rebased = rebaseProfileValue(
      formBaseValuesRef.current,
      structuredClone(form.state.values),
      remoteValues,
      "form",
    );
    if (rebased.conflicts.length > 0) {
      setStatusTone("warning");
      setStatusMessage(
        `Saved and local edits overlap at ${rebased.conflicts.slice(0, 3).join(", ")}. `
          + "Resolve those fields manually or discard the draft before saving.",
      );
      return;
    }
    const values = rebased.value as ProfileFormValues;
    formBaseResponseRef.current = initial;
    formBaseValuesRef.current = structuredClone(remoteValues);
    setFormBaseVersion(initial.profileVersion);
    expectedProfileVersionRef.current = initial.profileVersion ?? undefined;
    if (profileSaveVersionFenceRef.current !== undefined) {
      profileSaveVersionFenceRef.current = initial.profileVersion ?? undefined;
    }
    plateProfileProjectionRef.current = null;
    form.reset(remoteValues);
    if (!jsonValuesEqual(values.profile, remoteValues.profile)) {
      form.setFieldValue("profile", values.profile);
    }
    if (!jsonValuesEqual(values.style, remoteValues.style)) {
      form.setFieldValue("style", values.style);
    }
    if (values.templateText !== remoteValues.templateText) {
      form.setFieldValue("templateText", values.templateText);
    }
    onPreviewSourceChange?.(initial);
    setResetToken((token) => token + 1);
    setStatusTone("warning");
    setStatusMessage("Draft rebased onto the latest saved profile. Review and save your pending edits.");
  }, [form, initial, onPreviewSourceChange]);

  const resolveSuggestionReviewWithoutAcceptance = useCallback((expectedProfileVersion: number) => {
    if (
      !suggestionDerivedDraft
      || suggestionAddedRolesRef.current.length > 0
      || suggestionAddedPreferencesRef.current.length > 0
      || !suggestionReviewRequiredRef.current
      || expectedProfileVersion !== initial.profileVersion
    ) return;
    suggestionAddedRolesRef.current = [];
    suggestionAddedPreferencesRef.current = [];
    suggestionReviewRequiredRef.current = false;
    suggestionReviewResolvedVersionRef.current = expectedProfileVersion;
    expectedProfileVersionRef.current = expectedProfileVersion;
    setSuggestionDerivedDraft(false);
    setStatusTone("warning");
    setStatusMessage("Suggestion review completed. Rebased manual edits can now be saved.");
  }, [initial.profileVersion, suggestionDerivedDraft]);

  const acceptRequiredBulletSuggestion = useCallback(async (
    suggestion: RequiredBulletSuggestion,
    expectedProfileVersion: number,
  ): Promise<boolean> => {
    if (
      requiredAcceptPendingRef.current
      || requiredPinConflictRef.current !== null
      || form.state.isDirty
      || form.state.isSubmitting
      || expectedProfileVersion !== initial.profileVersion
      || expectedProfileVersion !== formBaseVersion
      || suggestion.kind !== "grammar"
      || !suggestion.canApply
      || suggestion.proposedText === null
    ) return false;
    const parsed = ProfileSchema.safeParse(form.state.values.profile);
    if (!parsed.success) return false;
    const normalizedOriginal = suggestion.originalText.trim().replace(/\s+/g, " ");
    const matchingEntries = parsed.data.resume.experience_entries.filter(
      (entry) => entry.id === suggestion.source.experienceId,
    );
    const entry = matchingEntries.length === 1 ? matchingEntries[0] : undefined;
    const entryIndex = parsed.data.resume.experience_entries.findIndex(
      (candidate) => candidate.id === suggestion.source.experienceId,
    );
    const requiredBullets = ownRequiredBullets(parsed.data, suggestion.source.experienceId);
    const matchingAchievements = entry?.achievement_evidence.filter(
      (candidate) => candidate.source_text.trim().replace(/\s+/g, " ") === normalizedOriginal,
    ) ?? [];
    const matchingAchievementIdCount = parsed.data.resume.experience_entries.reduce(
      (count, candidate) => count + candidate.achievement_evidence.filter(
        (evidence) => evidence.id === suggestion.source.sourceId,
      ).length,
      0,
    );
    const sourceMatches = suggestion.source.identityKind === "canonical_achievement"
      ? matchingAchievements.length === 1
        && matchingAchievements[0]!.id.trim().length > 0
        && matchingAchievements[0]!.id.length <= 240
        && matchingAchievements[0]?.id === suggestion.source.sourceId
        && matchingAchievementIdCount === 1
      : matchingAchievements.length === 0
        && suggestion.source.sourceId === `profile:v${expectedProfileVersion}:experience[${entryIndex}]:bullet[${suggestion.source.bulletIndex}]`;
    if (
      !entry
      || entry.title !== suggestion.source.experienceTitle
      || entry.company !== suggestion.source.experienceCompany
      || suggestion.source.excerpt !== (
        suggestion.originalText.length <= 500
          ? suggestion.originalText
          : `${suggestion.originalText.slice(0, 497)}...`
      )
      || suggestion.source.fieldPath !== `profile.resume.experience_entries[${entryIndex}].bullets[${suggestion.source.bulletIndex}]`
      || !sourceMatches
      || entry.bullets[suggestion.source.bulletIndex] !== suggestion.originalText
      || requiredBullets?.[suggestion.source.requiredBulletIndex] !== suggestion.originalText
      || entry.bullets.filter((bullet) => bullet === suggestion.originalText).length !== 1
      || requiredBullets?.filter((bullet) => bullet === suggestion.originalText).length !== 1
      || normalizedOriginal !== suggestion.proposedText
      || entry.bullets.some((bullet, index) => index !== suggestion.source.bulletIndex
        && bullet === suggestion.proposedText)
      || requiredBullets?.some((bullet, index) => index !== suggestion.source.requiredBulletIndex
        && bullet === suggestion.proposedText)
    ) {
      setStatusTone("warning");
      setStatusMessage("The saved Required bullet no longer matches this suggestion. Inspect it again.");
      return false;
    }

    const submittedBase = structuredClone(form.state.values);
    const nextValues = structuredClone(submittedBase);
    if (!nextValues.profile) return false;
    const bulletPath = `resume.experience_entries.${entryIndex}.bullets.${suggestion.source.bulletIndex}`;
    setPathValue(nextValues.profile, bulletPath, suggestion.proposedText);
    if (!setRequiredBulletText(
      nextValues.profile,
      suggestion.source.experienceId,
      suggestion.source.requiredBulletIndex,
      suggestion.proposedText,
    )) return false;
    requiredAcceptPendingRef.current = true;
    profileSaveVersionFenceRef.current = expectedProfileVersion;
    try {
      const response = await updateProfile.mutateAsync(toUpdateRequest(nextValues, expectedProfileVersion));
      // The optimistic query patch can show either snapshot while the request
      // is pending. Neither one is a manual edit to the accepted bullet.
      const baselineBulletTexts = new Set([suggestion.originalText, suggestion.proposedText]);
      formBaseResponseRef.current = response;
      formBaseValuesRef.current = structuredClone(toProfileFormValues(response));
      setFormBaseVersion(response.profileVersion);
      expectedProfileVersionRef.current = response.profileVersion ?? undefined;
      profileSaveVersionFenceRef.current = response.profileVersion ?? undefined;
      if (jsonValuesEqual(form.state.values, submittedBase)
        || jsonValuesEqual(form.state.values, nextValues)) {
        expectedProfileVersionRef.current = undefined;
        requiredPinConflictRef.current = null;
        plateProfileProjectionRef.current = null;
        form.reset(toProfileFormValues(response));
        onPreviewSourceChange?.(response);
        setResetToken((token) => token + 1);
        setStatusTone("saved");
        setStatusMessage("Required bullet suggestion accepted and saved");
      } else {
        const currentValues = structuredClone(form.state.values);
        const currentProfile = ProfileSchema.safeParse(currentValues.profile);
        const parsedCurrentProfile = currentProfile.success ? currentProfile.data : null;
        const currentEntry = parsedCurrentProfile
          ? parsedCurrentProfile.resume.experience_entries.filter(
            (candidate) => candidate.id === suggestion.source.experienceId,
          )
          : [];
        const currentRequired = currentEntry.length === 1 && parsedCurrentProfile
          ? ownRequiredBullets(parsedCurrentProfile, suggestion.source.experienceId)
          : undefined;
        const originalBulletIndexes = currentEntry[0]?.bullets.flatMap((bullet, index) =>
          bullet === suggestion.originalText ? [index] : []) ?? [];
        const proposedBulletIndexes = currentEntry[0]?.bullets.flatMap((bullet, index) =>
          bullet === suggestion.proposedText ? [index] : []) ?? [];
        const acceptedBulletIndexes = originalBulletIndexes.length > 0
          ? originalBulletIndexes : proposedBulletIndexes;
        let pinAmbiguous = false;
        const acceptedFieldOverlaps = currentEntry.length !== 1
          || parsedCurrentProfile?.resume.experience_entries.findIndex(
            (candidate) => candidate.id === suggestion.source.experienceId,
          ) !== entryIndex
          || currentEntry[0]!.title !== suggestion.source.experienceTitle
          || currentEntry[0]!.company !== suggestion.source.experienceCompany
          || acceptedBulletIndexes.length !== 1
          || !baselineBulletTexts.has(currentRequired?.[suggestion.source.requiredBulletIndex] ?? "");
        if (!acceptedFieldOverlaps && currentValues.profile) {
          const acceptedBulletIndex = acceptedBulletIndexes[0]!;
          setPathValue(
            currentValues.profile,
            `resume.experience_entries.${entryIndex}.bullets.${acceptedBulletIndex}`,
            suggestion.proposedText,
          );
          setRequiredBulletText(
            currentValues.profile,
            suggestion.source.experienceId,
            suggestion.source.requiredBulletIndex,
            suggestion.proposedText,
          );
          requiredPinConflictRef.current = {
            experienceId: suggestion.source.experienceId,
            entryIndex,
            bulletIndex: acceptedBulletIndex,
            requiredBulletIndex: suggestion.source.requiredBulletIndex,
            previousText: suggestion.proposedText,
            baselineBullets: currentEntry[0]!.bullets.map((bullet, index) =>
              index === acceptedBulletIndex ? suggestion.proposedText! : bullet),
          };
        } else if (
          currentValues.profile
          && baselineBulletTexts.has(currentRequired?.[suggestion.source.requiredBulletIndex] ?? "")
        ) {
          const conflict = {
            experienceId: suggestion.source.experienceId,
            entryIndex,
            bulletIndex: suggestion.source.bulletIndex,
            requiredBulletIndex: suggestion.source.requiredBulletIndex,
            previousText: currentRequired![suggestion.source.requiredBulletIndex]!,
            baselineBullets: [...entry.bullets],
          };
          pinAmbiguous = reconcilePendingRequiredPin(currentValues.profile, conflict) === "blocked";
          requiredPinConflictRef.current = conflict;
        } else {
          requiredPinConflictRef.current = null;
        }
        const rebasedProfile = ProfileSchema.safeParse(currentValues.profile);
        const rebasedEntry = rebasedProfile.success
          ? rebasedProfile.data.resume.experience_entries[entryIndex]
          : undefined;
        const rebasedRequired = rebasedProfile.success
          ? ownRequiredBullets(rebasedProfile.data, suggestion.source.experienceId)
          : undefined;
        if (rebasedEntry?.id === suggestion.source.experienceId
          && rebasedRequired?.[suggestion.source.requiredBulletIndex] === suggestion.proposedText
          && (rebasedEntry.bullets.filter((bullet) => bullet === suggestion.proposedText).length !== 1
            || rebasedRequired.filter((bullet) => bullet === suggestion.proposedText).length !== 1)) {
          requiredPinConflictRef.current = {
            experienceId: suggestion.source.experienceId,
            entryIndex,
            bulletIndex: rebasedEntry.bullets.indexOf(suggestion.proposedText),
            requiredBulletIndex: suggestion.source.requiredBulletIndex,
            previousText: suggestion.proposedText,
            baselineBullets: [...rebasedEntry.bullets],
          };
          pinAmbiguous = true;
        }
        const responseValues = toProfileFormValues(response);
        form.reset(responseValues);
        if (!jsonValuesEqual(currentValues.profile, responseValues.profile)) {
          form.setFieldValue("profile", currentValues.profile);
        }
        if (!jsonValuesEqual(currentValues.style, responseValues.style)) {
          form.setFieldValue("style", currentValues.style);
        }
        if (currentValues.templateText !== responseValues.templateText) {
          form.setFieldValue("templateText", currentValues.templateText);
        }
        onPreviewSourceChange?.(response);
        setStatusTone("warning");
        setStatusMessage(
          pinAmbiguous
            ? "Suggestion saved, but a manual edit makes the Required pin ambiguous. Make the bullet text unique before saving the pending draft."
            : acceptedFieldOverlaps
            ? "Suggestion saved, but a newer manual edit overlaps that Required bullet. The manual edit remains pending on the updated profile version."
            : "Suggestion saved and rebased into newer non-overlapping manual edits. Those edits remain pending on the updated profile version.",
        );
      }
      return true;
    } catch {
      // A timeout can follow a committed write. Keep subsequent manual saves
      // bound to the inspected version until a refreshed snapshot is rebased.
      expectedProfileVersionRef.current = formBaseVersionRef.current ?? expectedProfileVersion;
      profileSaveVersionFenceRef.current = expectedProfileVersion;
      requiredPinConflictRef.current = {
        experienceId: suggestion.source.experienceId,
        entryIndex,
        bulletIndex: suggestion.source.bulletIndex,
        requiredBulletIndex: suggestion.source.requiredBulletIndex,
        previousText: suggestion.originalText,
        baselineBullets: [...entry.bullets],
      };
      let pinNeedsResolution = false;
      const draftProfile = form.state.values.profile;
      const parsedDraft = ProfileSchema.safeParse(draftProfile);
      if (draftProfile && parsedDraft.success) {
        const draftEntries = parsedDraft.data.resume.experience_entries;
        const draftEntry = draftEntries[entryIndex];
        const draftPin = ownRequiredBullets(parsedDraft.data, suggestion.source.experienceId)
          ?.[suggestion.source.requiredBulletIndex];
        if (draftEntry?.id === suggestion.source.experienceId && typeof draftPin === "string") {
          const conflict = {
            experienceId: suggestion.source.experienceId,
            entryIndex,
            bulletIndex: suggestion.source.bulletIndex,
            requiredBulletIndex: suggestion.source.requiredBulletIndex,
            previousText: draftPin,
            baselineBullets: [...entry.bullets],
          };
          requiredPinConflictRef.current = conflict;
          const correctedProfile = structuredClone(draftProfile);
          const pinStatus = reconcilePendingRequiredPin(correctedProfile, conflict);
          if (pinStatus === "blocked") {
            pinNeedsResolution = true;
          } else if (pinStatus === "updated") {
            form.setFieldValue("profile", correctedProfile);
          }
        } else if (draftPin === undefined) {
          // The user explicitly removed this pin during the pending request.
          requiredPinConflictRef.current = null;
        }
      }
      setStatusTone("warning");
      setStatusMessage(
        "The suggestion save did not return a confirmed result. Rebase or reload the saved profile before retrying; manual editing remains available."
        + (pinNeedsResolution ? " Resolve the ambiguous Required pin before saving." : ""),
      );
      return false;
    } finally {
      requiredAcceptPendingRef.current = false;
    }
  }, [form, formBaseVersion, initial.profileVersion, onPreviewSourceChange, updateProfile]);

  return (
    <form
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
      onReset={(event) => {
        event.preventDefault();
        plateProfileProjectionRef.current = null;
        expectedProfileVersionRef.current = undefined;
        requiredPinConflictRef.current = null;
        const savedFence = profileSaveVersionFenceRef.current;
        const useSavedResponse = savedFence !== undefined
          && formBaseVersionRef.current === savedFence
          && (initial.profileVersion === null || initial.profileVersion < savedFence);
        const baseResponse = useSavedResponse ? formBaseResponseRef.current : initial;
        const initialValues = structuredClone(toProfileFormValues(baseResponse));
        if (savedFence !== undefined
          && initial.profileVersion !== null && initial.profileVersion > savedFence) {
          profileSaveVersionFenceRef.current = undefined;
        }
        formBaseResponseRef.current = baseResponse;
        formBaseValuesRef.current = structuredClone(initialValues);
        suggestionAddedRolesRef.current = [];
        suggestionAddedPreferencesRef.current = [];
        suggestionReviewRequiredRef.current = false;
        suggestionReviewResolvedVersionRef.current = undefined;
        setFormBaseVersion(baseResponse.profileVersion);
        setSuggestionDerivedDraft(false);
        form.reset(initialValues);
        onPreviewSourceChange?.(baseResponse);
        setResetToken((token) => token + 1);
        clearTransientStatus();
      }}
    >
      {statusMessage ? (
        <div
          className="status-line profile-save-status"
          data-state={statusTone}
          data-typography="metadata"
          role={statusTone === "warning" ? "alert" : "status"}
        >
          {statusMessage}
        </div>
      ) : null}
      <form.Subscribe
        selector={(state) => ({
          isDirty: state.isDirty,
          isSubmitting: state.isSubmitting,
          values: state.values,
        })}
      >
        {({ isDirty, isSubmitting, values }) => (
          <AutosaveUndoController
            formRef={formRef}
            isDirty={isDirty}
            isSubmitting={isSubmitting}
            resetToken={resetToken}
            restoreValues={(nextValues) => {
              reconcileSuggestionProvenance(nextValues.profile);
              form.reset(nextValues, { keepDefaultValues: true });
            }}
            setStatusMessage={setStatusMessage}
            submit={() => form.handleSubmit()}
            values={values}
          />
        )}
      </form.Subscribe>
      {isProfileSection ? (
        <div className="profile-route-actions">
          <Button
            nativeButton={false}
            render={<Link to="/profile/import/upload" role="link" />}
            variant="secondary"
          >
            Import resume
          </Button>
        </div>
      ) : null}
      <form.Subscribe selector={(state) => ({ isDirty: state.isDirty, isSubmitting: state.isSubmitting })}>
        {({ isDirty, isSubmitting }) =>
          isDirty || isSubmitting ? (
            <div className="editor-bulk-actions" data-state={isSubmitting ? "saving" : "dirty"}>
              <span data-typography="strong-body" role="status">
                {isSubmitting ? "Saving changes" : "Unsaved changes"}
              </span>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Saving changes" : saveLabel}
              </Button>
              <Button type="reset" variant="secondary" disabled={isSubmitting}>
                {discardLabel}
              </Button>
            </div>
          ) : null
        }
      </form.Subscribe>
      {section !== "target-search" && initial.profileVersion !== null
        && (formBaseVersion === null || initial.profileVersion > formBaseVersion) ? (
        <div className="editor-bulk-actions">
          <Button type="button" variant="secondary" onClick={rebaseProfileDraft}>
            Rebase edits onto saved profile
          </Button>
        </div>
      ) : null}
      {isProfileSection ? (
        <form.Subscribe selector={(state) => ({ isDirty: state.isDirty, isSubmitting: state.isSubmitting })}>
          {({ isDirty, isSubmitting }) => (
            <RequiredBulletSuggestions
              isDraftClean={!isDirty && !isSubmitting && !updateProfile.isPending
                && formBaseVersion === initial.profileVersion && !requiredAcceptPendingRef.current}
              profileVersion={initial.profileVersion}
              resetToken={resetToken}
              onAccept={acceptRequiredBulletSuggestion}
            />
          )}
        </form.Subscribe>
      ) : null}
      <form.Field name="profile">
        {(profileField) => (
          <form.Field name="style">
            {(styleField) => (
              <>
                {section === "target-search" ? (
                  <TargetRoleSuggestions
                    formBaseVersion={formBaseVersion}
                    profileVersion={initial.profileVersion}
                    onRebase={rebaseOntoSavedProfile}
                    onResolveWithoutAcceptance={resolveSuggestionReviewWithoutAcceptance}
                    onAccept={(titles, preferences, expectedProfileVersion) => {
                      const rolesBefore = targetRoles(profileField.state.value);
                      const preferencesBefore = targetPreferenceRows(profileField.state.value);
                      const nextProfile = appendTargetPreferences(
                        appendTargetRoles(profileField.state.value, titles),
                        preferences,
                      );
                      const beforeKeys = new Set(rolesBefore.map((title) => title.toLowerCase()));
                      const beforePreferenceKeys = new Set(preferencesBefore.map(preferenceRowKey));
                      const addedTitles = targetRoles(nextProfile).filter(
                        (title) => !beforeKeys.has(title.toLowerCase()),
                      );
                      const addedPreferences = targetPreferenceRows(nextProfile).filter(
                        (row) => !beforePreferenceKeys.has(preferenceRowKey(row)),
                      );
                      suggestionAddedRolesRef.current = [
                        ...suggestionAddedRolesRef.current,
                        ...addedTitles
                          .filter((title) => !suggestionAddedRolesRef.current.some(
                            (existing) => existing.title.toLowerCase() === title.toLowerCase(),
                          ))
                          .map((title) => ({ profileVersion: expectedProfileVersion, title })),
                      ];
                      suggestionAddedPreferencesRef.current = [
                        ...suggestionAddedPreferencesRef.current,
                        ...addedPreferences
                          .filter((row) => !suggestionAddedPreferencesRef.current.some(
                            (existing) => preferenceRowKey(existing) === preferenceRowKey(row),
                          ))
                          .map((row) => ({ ...row, profileVersion: expectedProfileVersion })),
                      ];
                      clearTransientStatus();
                      profileField.handleChange(nextProfile);
                      if (suggestionAddedRolesRef.current.length > 0 || suggestionAddedPreferencesRef.current.length > 0) {
                        suggestionReviewRequiredRef.current = false;
                        suggestionReviewResolvedVersionRef.current = undefined;
                        expectedProfileVersionRef.current = expectedProfileVersion;
                        setSuggestionDerivedDraft(true);
                      } else {
                        resolveSuggestionReviewWithoutAcceptance(expectedProfileVersion);
                      }
                    }}
                  />
                ) : null}
                <StructuredProfileEditor
                  mode={section}
                  showSectionHeading={showSectionHeading}
                  profile={profileField.state.value}
                  style={styleField.state.value}
                  onProfileChange={(value) => {
                    clearTransientStatus();
                    const conflict = requiredPinConflictRef.current;
                    if (!conflict || !value) {
                      profileField.handleChange(value);
                      return;
                    }
                    if (explicitlyRemovedRequiredPin(profileField.state.value, value, conflict)) {
                      requiredPinConflictRef.current = null;
                      profileField.handleChange(value);
                      return;
                    }
                    const correctedProfile = structuredClone(value);
                    const pinStatus = reconcilePendingRequiredPin(correctedProfile, conflict);
                    if (pinStatus === "updated") {
                      const bullet = getPathValue(correctedProfile,
                        `resume.experience_entries.${conflict.entryIndex}.bullets.${conflict.bulletIndex}`);
                      if (typeof bullet === "string") {
                        requiredPinConflictRef.current = { ...conflict, previousText: bullet };
                      }
                      profileField.handleChange(correctedProfile);
                    } else {
                      profileField.handleChange(value);
                      if (pinStatus === "blocked" && ProfileSchema.safeParse(value).success) {
                        setStatusTone("warning");
                        setStatusMessage("The edited Required bullet has an ambiguous pin. Make its text unique or discard the draft before saving.");
                      }
                    }
                  }}
                  onStyleChange={(value) => {
                    clearTransientStatus();
                    styleField.handleChange(value);
                  }}
                />
              </>
            )}
          </form.Field>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.errors}>
        {(errors) => {
          const message = errors
            .flat()
            .filter((entry): entry is string => typeof entry === "string")
            .at(0);
          return message ? (
            <Alert className="inline" variant="destructive">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null;
        }}
      </form.Subscribe>
      {updateProfile.error ? (
        <Alert className="inline" variant="destructive">
          <AlertDescription>{updateProfile.error.message}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}
