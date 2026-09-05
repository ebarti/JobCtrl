import {
  ProfileSchema,
  type ProfileShape,
  type ProfileUpdateRequest,
} from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ProfileConfigResponse } from "../../operations/types.js";
import { Alert, AlertDescription } from "../../../shared/ui/alert.js";
import { Button } from "../../../shared/ui/button.js";
import { isJsonRecord, setPathValue, type JsonRecord } from "../lib/json-record.js";
import { StructuredProfileEditor } from "../components/StructuredProfileEditor.js";
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

function toUpdateRequest(values: ProfileFormValues): ProfileUpdateRequest {
  return {
    profileText: JSON.stringify(values.profile, null, 2),
    styleText: JSON.stringify(values.style, null, 2),
    templateText: values.templateText,
  };
}

function serializeProfileValues(values: ProfileFormValues): string {
  return JSON.stringify(values);
}

interface AppliedPlateTarget {
  readonly bulletIndex?: number;
  readonly texts: readonly string[];
}

interface PlateProfileProjectionState {
  readonly activeChanges: ReadonlyMap<string, ProfilePlateTextChange>;
  readonly appliedTargets: ReadonlyMap<string, AppliedPlateTarget>;
}

interface PlateProfileProjectionResult {
  readonly conflictCount: number;
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
    profile: profileDraft,
    state: { activeChanges, appliedTargets },
  });
  const profileResult = ProfileSchema.safeParse(profileDraft);
  if (!profileDraft || !profileResult.success) return unchangedResult();

  // Parsed values supply validated semantic reads only. Write changed fields
  // into the original draft so unknown fields and incomplete input survive.
  const profile = profileResult.data;
  const updatedProfile = structuredClone(profileDraft);
  let changed = false;
  let conflictCount = 0;
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
    current: string,
    update: (value: string) => void,
  ): void => {
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
    if (change.semanticId === "personal:full_name") {
      applySingleText(change, profile.personal.full_name ?? "", (value) => {
        setPathValue(updatedProfile, "personal.full_name", value);
      });
      continue;
    }
    if (change.semanticId === "summary") {
      applySingleText(
        change,
        profile.resume.executive_profile.baseline_text ?? "",
        (value) => {
          setPathValue(updatedProfile, "resume.executive_profile.baseline_text", value);
        },
      );
      continue;
    }

    const summaryMatch = /^experience:(.+):summary$/.exec(change.semanticId);
    if (summaryMatch) {
      const entry = profile.resume.experience_entries.find(
        (candidate) => candidate.id === summaryMatch[1],
      );
      if (!entry) {
        appliedTargets.delete(change.semanticId);
        conflictCount += 1;
        continue;
      }
      applySingleText(change, entry.summary, (value) => {
        setPathValue(updatedProfile, `resume.experience_entries.${profile.resume.experience_entries.indexOf(entry)}.summary`, value);
      });
      continue;
    }

    const bulletMatch = /^experience:(.+):bullet:([1-9]\d*)$/.exec(
      change.semanticId,
    );
    if (bulletMatch) {
      const entryId = bulletMatch[1];
      const bulletOrdinal = bulletMatch[2];
      if (!entryId || !bulletOrdinal) continue;
      const entry = profile.resume.experience_entries.find(
        (candidate) => candidate.id === entryId,
      );
      if (!entry) {
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
          entry.bullets.slice(
            previousTarget.bulletIndex,
            previousTarget.bulletIndex + expectedTexts.length,
          ),
          expectedTexts,
        )
      ) {
        bulletIndex = previousTarget.bulletIndex;
      } else {
        const matches = matchingTextSequenceIndexes(entry.bullets, expectedTexts);
        if (matches.length === 1) {
          bulletIndex = matches[0] ?? null;
        }
      }
      if (bulletIndex === null) {
        appliedTargets.delete(change.semanticId);
        conflictCount += 1;
        continue;
      }
      const currentTexts = entry.bullets.slice(
        bulletIndex,
        bulletIndex + expectedTexts.length,
      );
      if (!plateTextArraysEqual(currentTexts, desiredTexts)) {
        entry.bullets.splice(bulletIndex, expectedTexts.length, ...desiredTexts);
        setPathValue(updatedProfile, `resume.experience_entries.${profile.resume.experience_entries.indexOf(entry)}.bullets`, entry.bullets);
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

  return {
    conflictCount,
    profile: changed ? updatedProfile : profileDraft,
    state: { activeChanges, appliedTargets },
  };
}

export function ProfileForm({
  initial,
  onPlateTextControllerChange,
  section = "profile",
  showSectionHeading = true,
}: ProfileFormProps) {
  const updateProfile = useUpdateProfileMutation();
  const [statusMessage, setStatusMessage] = useState("");
  const [statusTone, setStatusTone] = useState<"saved" | "warning">("saved");
  const [resetToken, setResetToken] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const plateProfileProjectionRef = useRef<PlateProfileProjectionState | null>(null);
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

  const form = useForm({
    defaultValues: toProfileFormValues(initial),
    validators: {
      onBlur: ({ value }) => validateProfileForm(value),
      onSubmit: ({ value }) => validateProfileForm(value),
    },
    onSubmit: async ({ value, formApi }) => {
      setStatusMessage("");
      const submittedValues = serializeProfileValues(value);
      const initialValues = toProfileFormValues(initial);
      const shouldUpdateProfile =
        submittedValues !== serializeProfileValues(initialValues);
      const profileResponse = shouldUpdateProfile
        ? await updateProfile.mutateAsync(toUpdateRequest(value))
        : initial;
      if (serializeProfileValues(formApi.state.values) === submittedValues) {
        plateProfileProjectionRef.current = null;
        formApi.reset(toProfileFormValues(profileResponse));
        setStatusTone("saved");
        setStatusMessage(savedMessage);
      } else {
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
      if (projection.conflictCount > 0) {
        setStatusTone("warning");
        setStatusMessage(
          "Some resume editor changes were not applied because the matching Profile data changed. Save or discard those Profile changes, then reopen the resume editor.",
        );
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
    if (form.state.isDirty || form.state.isSubmitting) {
      return;
    }
    plateProfileProjectionRef.current = null;
    form.reset(toProfileFormValues(initial));
    setResetToken((token) => token + 1);
  }, [form, initial]);

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
        form.reset(toProfileFormValues(initial));
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
            restoreValues={(nextValues) => form.reset(nextValues, { keepDefaultValues: true })}
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
      <form.Field name="profile">
        {(profileField) => (
          <form.Field name="style">
            {(styleField) => (
              <StructuredProfileEditor
                mode={section}
                showSectionHeading={showSectionHeading}
                profile={profileField.state.value}
                style={styleField.state.value}
                onProfileChange={(value) => {
                  clearTransientStatus();
                  profileField.handleChange(value);
                }}
                onStyleChange={(value) => {
                  clearTransientStatus();
                  styleField.handleChange(value);
                }}
              />
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
