import {
  ProfileSchema,
  SettingsUpdateRequestSchema,
  type ProfileShape,
  type ProfileUpdateRequest,
} from "@jobctl/contracts";
import { useForm } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import type { DashboardSettings, ProfileConfigResponse } from "../../operations/types.js";
import { Empty } from "../../../shared/ui/empty.js";
import { StructuredProfileEditor } from "../components/StructuredProfileEditor.js";
import { useUpdateProfileMutation } from "../hooks/useUpdateProfileMutation.js";
import { useUpdateSettingsMutation } from "../hooks/useUpdateSettingsMutation.js";
import { AutosaveUndoController } from "./autosave-undo-controller.js";
import {
  isProfileDateRangeChronological,
  parseProfileDateRange,
} from "../lib/profile-date-fields.js";

export type ProfileSection = "profile" | "preferences" | "target-search";

export interface ProfileFormValues {
  locationFilter: string;
  profileText: string;
  styleText: string;
  templateText: string;
}

export interface ProfileFormProps {
  initial: ProfileConfigResponse;
  section?: ProfileSection;
  settings?: DashboardSettings;
}

export function toProfileFormValues(profile: ProfileConfigResponse, settings?: DashboardSettings): ProfileFormValues {
  return {
    locationFilter: settings?.locationFilter ?? "",
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
  const settingsResult = SettingsUpdateRequestSchema.safeParse({ locationFilter: values.locationFilter });
  if (!settingsResult.success) {
    return `Location filter: ${settingsResult.error.issues[0]?.message ?? "invalid value"}`;
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

export function ProfileForm({ initial, section = "profile", settings }: ProfileFormProps) {
  const updateProfile = useUpdateProfileMutation();
  const updateSettings = useUpdateSettingsMutation();
  const [statusMessage, setStatusMessage] = useState("");
  const [resetToken, setResetToken] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const isProfileSection = section === "profile";
  const saveLabel = section === "target-search" ? "save discovery settings" : "save all";
  const discardLabel = section === "target-search" ? "discard changes" : "discard all";
  const savedMessage =
    section === "profile" ? "profile saved" : section === "target-search" ? "discovery settings saved" : "preferences saved";

  const form = useForm({
    defaultValues: toProfileFormValues(initial, settings),
    validators: {
      onBlur: ({ value }) => validateProfileForm(value),
      onSubmit: ({ value }) => validateProfileForm(value),
    },
    onSubmit: async ({ value, formApi }) => {
      setStatusMessage("");
      const submittedValues = serializeProfileValues(value);
      const initialValues = toProfileFormValues(initial, settings);
      const shouldUpdateProfile =
        value.profileText !== initialValues.profileText ||
        value.styleText !== initialValues.styleText ||
        value.templateText !== initialValues.templateText;
      const shouldUpdateSettings =
        section === "preferences" && settings !== undefined && value.locationFilter !== settings.locationFilter;
      const [profileResponse, settingsResponse] = await Promise.all([
        shouldUpdateProfile ? updateProfile.mutateAsync(toUpdateRequest(value)) : Promise.resolve(initial),
        shouldUpdateSettings
          ? updateSettings.mutateAsync({ locationFilter: value.locationFilter })
          : Promise.resolve(undefined),
      ]);
      if (serializeProfileValues(formApi.state.values) === submittedValues) {
        formApi.reset(toProfileFormValues(profileResponse, settingsResponse?.settings ?? settings));
        setStatusMessage(savedMessage);
      } else {
        setStatusMessage("saved; newer changes pending");
      }
    },
  });

  useEffect(() => {
    if (form.state.isDirty || form.state.isSubmitting) {
      return;
    }
    form.reset(toProfileFormValues(initial, settings));
    setResetToken((token) => token + 1);
  }, [form, initial, settings]);

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
        form.reset(toProfileFormValues(initial, settings));
        setResetToken((token) => token + 1);
        setStatusMessage("");
      }}
    >
      {statusMessage ? <div className="status-line">{statusMessage}</div> : null}
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
      <form.Subscribe selector={(state) => ({ isDirty: state.isDirty, isSubmitting: state.isSubmitting })}>
        {({ isDirty, isSubmitting }) => (
          <div className="editor-bulk-actions">
            {isProfileSection ? (
              <Link className="tab on" to="/profile/import/upload">
                import resume
              </Link>
            ) : null}
            <button
              className="tab on"
              type="submit"
              disabled={!isDirty || isSubmitting}
            >
              {isSubmitting ? "saving" : saveLabel}
            </button>
            <button
              className="tab"
              type="reset"
              disabled={!isDirty || isSubmitting}
            >
              {discardLabel}
            </button>
          </div>
        )}
      </form.Subscribe>
      <form.Field name="profileText">
        {(profileField) => (
          <form.Field name="styleText">
            {(styleField) => (
              <form.Field name="locationFilter">
                {(locationFilterField) => (
                  <StructuredProfileEditor
                    applicationConfigurationFields={
                      section === "preferences" && settings ? (
                        <label className="field">
                          <span>Location filter</span>
                          <input
                            value={locationFilterField.state.value}
                            onBlur={locationFilterField.handleBlur}
                            onChange={(event) => locationFilterField.handleChange(event.target.value)}
                          />
                        </label>
                      ) : null
                    }
                    mode={section}
                    profileText={profileField.state.value}
                    styleText={styleField.state.value}
                    onProfileTextChange={(value) => profileField.handleChange(value)}
                    onStyleTextChange={(value) => styleField.handleChange(value)}
                  />
                )}
              </form.Field>
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
          return message ? <div className="banner inline">{message}</div> : null;
        }}
      </form.Subscribe>
      {updateProfile.error || updateSettings.error ? (
        <div className="banner inline">{(updateProfile.error ?? updateSettings.error)?.message}</div>
      ) : null}
      {!form.state.values.profileText && !form.state.values.styleText ? (
        <Empty title="Loading profile." />
      ) : null}
    </form>
  );
}
