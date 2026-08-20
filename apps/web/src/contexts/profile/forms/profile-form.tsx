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
import { Empty } from "../../../shared/ui/empty.js";
import { StructuredProfileEditor } from "../components/StructuredProfileEditor.js";
import { useUpdateProfileMutation } from "../hooks/useUpdateProfileMutation.js";
import { AutosaveUndoController } from "../../../shared/ui/autosave-undo-controller.js";
import {
  isProfileDateRangeChronological,
  parseProfileDateRange,
} from "../lib/profile-date-fields.js";

export type ProfileSection = "profile" | "preferences" | "target-search";

export interface ProfileFormValues {
  profileText: string;
  styleText: string;
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
  readonly text: string;
}

export interface ProfilePlateTextController {
  readonly apply: (changes: readonly ProfilePlateTextChange[]) => void;
}

export function toProfileFormValues(profile: ProfileConfigResponse): ProfileFormValues {
  return {
    profileText: JSON.stringify(profile.profile, null, 2),
    styleText: JSON.stringify(profile.style, null, 2),
    templateText: profile.templateText,
  };
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (parseError) {
    return {
      ok: false,
      error: parseError instanceof Error ? parseError.message : "Invalid JSON",
    };
  }
}

function validateProfileForm(values: ProfileFormValues): string | undefined {
  const parsedProfile = tryParseJson(values.profileText);
  if (!parsedProfile.ok) {
    return `Profile data: ${parsedProfile.error}`;
  }
  const profileResult = ProfileSchema.safeParse(parsedProfile.value);
  if (!profileResult.success) {
    return `Profile data: ${profileResult.error.issues[0]?.message ?? "invalid profile"}`;
  }
  const profileDateError = validateProfileDateRanges(profileResult.data);
  if (profileDateError) {
    return profileDateError;
  }
  const parsedStyle = tryParseJson(values.styleText);
  if (!parsedStyle.ok) {
    return `Resume style settings: ${parsedStyle.error}`;
  }
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
    profileText: values.profileText,
    styleText: values.styleText,
    templateText: values.templateText,
  };
}

function serializeProfileValues(values: ProfileFormValues): string {
  return JSON.stringify(values);
}

function profileTextWithPlateChanges(
  profileText: string,
  changes: readonly ProfilePlateTextChange[],
  plateBaselineProfileText = profileText,
): string {
  const parsed = tryParseJson(profileText);
  if (!parsed.ok) return profileText;
  const profileResult = ProfileSchema.safeParse(parsed.value);
  if (!profileResult.success) return profileText;
  const parsedBaseline = tryParseJson(plateBaselineProfileText);
  const baselineResult = parsedBaseline.ok
    ? ProfileSchema.safeParse(parsedBaseline.value)
    : null;
  const baselineProfile = baselineResult?.success
    ? baselineResult.data
    : profileResult.data;

  const profile = structuredClone(profileResult.data);
  let changed = false;
  // Slate block splits copy the source element's semantic ID. Preserve every
  // ordered occurrence so a split bullet becomes replacement + insertion.
  const bulletChangesByEntryId = new Map<string, Map<number, string[]>>();
  const replace = (current: string, next: string, update: () => void): void => {
    if (current === next) return;
    update();
    changed = true;
  };

  for (const change of changes) {
    if (change.semanticId === "personal:full_name") {
      replace(profile.personal.full_name ?? "", change.text, () => {
        profile.personal.full_name = change.text;
      });
      continue;
    }
    if (change.semanticId === "summary") {
      replace(profile.resume.executive_profile.baseline_text ?? "", change.text, () => {
        profile.resume.executive_profile.baseline_text = change.text;
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
      const bulletIndex = Number(bulletOrdinal) - 1;
      const changesByIndex =
        bulletChangesByEntryId.get(entryId) ?? new Map<number, string[]>();
      const texts = changesByIndex.get(bulletIndex) ?? [];
      texts.push(change.text);
      changesByIndex.set(bulletIndex, texts);
      bulletChangesByEntryId.set(entryId, changesByIndex);
      continue;
    }

    const summaryMatch = /^experience:(.+):summary$/.exec(change.semanticId);
    if (summaryMatch) {
      const entry = profile.resume.experience_entries.find((candidate) => candidate.id === summaryMatch[1]);
      if (entry) {
        replace(entry.summary, change.text, () => {
          entry.summary = change.text;
        });
      }
    }
  }

  for (const [entryId, changesByIndex] of bulletChangesByEntryId) {
    const entry = profile.resume.experience_entries.find(
      (candidate) => candidate.id === entryId,
    );
    const baselineEntry = baselineProfile.resume.experience_entries.find(
      (candidate) => candidate.id === entryId,
    );
    if (!entry) continue;
    const baselineBullets = baselineEntry?.bullets ?? entry.bullets;
    const nextBullets = baselineBullets.flatMap((bullet, bulletIndex) => {
      const texts = changesByIndex.get(bulletIndex);
      if (!texts) return [bullet];
      if (texts.length > 1 && texts.some((text) => !text.trim())) {
        return [bullet];
      }
      return texts;
    });
    if (
      entry.bullets.length !== nextBullets.length ||
      entry.bullets.some((bullet, index) => bullet !== nextBullets[index])
    ) {
      entry.bullets = nextBullets;
      changed = true;
    }
  }

  return changed ? JSON.stringify(profile, null, 2) : profileText;
}

interface PlateProfileProjectionState {
  readonly baselineProfileText: string;
  readonly lastAppliedProfileText: string;
}

export function ProfileForm({
  initial,
  onPlateTextControllerChange,
  section = "profile",
  showSectionHeading = true,
}: ProfileFormProps) {
  const updateProfile = useUpdateProfileMutation();
  const [statusMessage, setStatusMessage] = useState("");
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
        value.profileText !== initialValues.profileText ||
        value.styleText !== initialValues.styleText ||
        value.templateText !== initialValues.templateText;
      const profileResponse = shouldUpdateProfile
        ? await updateProfile.mutateAsync(toUpdateRequest(value))
        : initial;
      if (serializeProfileValues(formApi.state.values) === submittedValues) {
        plateProfileProjectionRef.current = null;
        formApi.reset(toProfileFormValues(profileResponse));
        setStatusMessage(savedMessage);
      } else {
        setStatusMessage("Saved; newer changes pending");
      }
    },
  });

  const applyPlateTextChanges = useCallback(
    (changes: readonly ProfilePlateTextChange[]) => {
      const currentProfileText = form.state.values.profileText;
      const previousProjection = plateProfileProjectionRef.current;
      // Reapply Plate's complete semantic snapshot to one stable baseline.
      // Otherwise every keystroke in an inserted split node would insert it again.
      const baselineProfileText =
        previousProjection?.lastAppliedProfileText === currentProfileText
          ? previousProjection.baselineProfileText
          : currentProfileText;
      const nextProfileText = profileTextWithPlateChanges(
        currentProfileText,
        changes,
        baselineProfileText,
      );
      plateProfileProjectionRef.current = {
        baselineProfileText,
        lastAppliedProfileText: nextProfileText,
      };
      if (nextProfileText === currentProfileText) return;
      clearTransientStatus();
      form.setFieldValue("profileText", nextProfileText);
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
          data-state="saved"
          data-typography="metadata"
          role="status"
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
      <form.Field name="profileText">
        {(profileField) => (
          <form.Field name="styleText">
            {(styleField) => (
              <StructuredProfileEditor
                mode={section}
                showSectionHeading={showSectionHeading}
                profileText={profileField.state.value}
                styleText={styleField.state.value}
                onProfileTextChange={(value) => {
                  clearTransientStatus();
                  profileField.handleChange(value);
                }}
                onStyleTextChange={(value) => {
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
      {!form.state.values.profileText && !form.state.values.styleText ? (
        <Empty title="Loading profile." />
      ) : null}
    </form>
  );
}
