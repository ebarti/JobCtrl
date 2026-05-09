import { ProfileSchema, type ProfileShape, type ProfileUpdateRequest } from "@jobhunter/contracts";
import { useForm } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { ProfileConfigResponse } from "../../operations/types.js";
import { Empty } from "../../../shared/ui/empty.js";
import { StructuredProfileEditor } from "../components/StructuredProfileEditor.js";
import { useUpdateProfileMutation } from "../hooks/useUpdateProfileMutation.js";
import {
  isProfileDateRangeChronological,
  parseProfileDateRange,
} from "../lib/profile-date-fields.js";

export type ProfileSection = "profile" | "preferences";

export interface ProfileFormValues {
  profileText: string;
  styleText: string;
  templateText: string;
}

export interface ProfileFormProps {
  initial: ProfileConfigResponse;
  section?: ProfileSection;
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

export function ProfileForm({ initial, section = "profile" }: ProfileFormProps) {
  const updateProfile = useUpdateProfileMutation();
  const [statusMessage, setStatusMessage] = useState("");
  const isProfileSection = section === "profile";

  const form = useForm({
    defaultValues: toProfileFormValues(initial),
    validators: {
      onBlur: ({ value }) => validateProfileForm(value),
      onSubmit: ({ value }) => validateProfileForm(value),
    },
    onSubmit: async ({ value, formApi }) => {
      setStatusMessage("");
      const response = await updateProfile.mutateAsync(toUpdateRequest(value));
      formApi.reset(toProfileFormValues(response));
      setStatusMessage(isProfileSection ? "profile saved" : "preferences saved");
    },
  });

  useEffect(() => {
    form.reset(toProfileFormValues(initial));
  }, [form, initial]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
      onReset={(event) => {
        event.preventDefault();
        form.reset(toProfileFormValues(initial));
        setStatusMessage("");
      }}
    >
      {statusMessage ? <div className="status-line">{statusMessage}</div> : null}
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
              {isSubmitting ? "saving" : "save all"}
            </button>
            <button
              className="tab"
              type="reset"
              disabled={!isDirty || isSubmitting}
            >
              discard all
            </button>
          </div>
        )}
      </form.Subscribe>
      <form.Field name="profileText">
        {(profileField) => (
          <form.Field name="styleText">
            {(styleField) => (
              <StructuredProfileEditor
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
      <form.Subscribe selector={(state) => state.errors}>
        {(errors) => {
          const message = errors
            .flat()
            .filter((entry): entry is string => typeof entry === "string")
            .at(0);
          return message ? <div className="banner inline">{message}</div> : null;
        }}
      </form.Subscribe>
      {updateProfile.error ? (
        <div className="banner inline">{updateProfile.error.message}</div>
      ) : null}
      {!form.state.values.profileText && !form.state.values.styleText ? (
        <Empty title="Loading profile." />
      ) : null}
    </form>
  );
}
