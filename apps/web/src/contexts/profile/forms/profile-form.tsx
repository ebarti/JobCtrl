import { ProfileSchema, type ProfileUpdateRequest } from "@jobhunter/contracts";
import { useForm } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { ProfileConfigResponse } from "../../operations/types.js";
import { Empty } from "../../../shared/ui/empty.js";
import { Editor } from "../components/Editor.js";
import { StructuredProfileEditor } from "../components/StructuredProfileEditor.js";
import { useUpdateProfileMutation } from "../hooks/useUpdateProfileMutation.js";

export type ProfileMode = "fields" | "source";

export interface ProfileFormValues {
  profileText: string;
  styleText: string;
  templateText: string;
}

export interface ProfileFormProps {
  initial: ProfileConfigResponse;
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
    return `profile.json: ${parsedProfile.error}`;
  }
  const profileResult = ProfileSchema.safeParse(parsedProfile.value);
  if (!profileResult.success) {
    return `profile.json: ${profileResult.error.issues[0]?.message ?? "invalid profile"}`;
  }
  const parsedStyle = tryParseJson(values.styleText);
  if (!parsedStyle.ok) {
    return `resume_style.json: ${parsedStyle.error}`;
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

export function ProfileForm({ initial }: ProfileFormProps) {
  const updateProfile = useUpdateProfileMutation();
  const [mode, setMode] = useState<ProfileMode>("fields");
  const [statusMessage, setStatusMessage] = useState("");

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
      setStatusMessage("profile saved");
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
            <Link className="tab on" to="/profile/import/upload">
              import resume
            </Link>
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
      <div className="profile-mode-tabs">
        <button
          className={`tab ${mode === "fields" ? "on" : ""}`}
          type="button"
          onClick={() => setMode("fields")}
        >
          fields
        </button>
        <button
          className={`tab ${mode === "source" ? "on" : ""}`}
          type="button"
          onClick={() => setMode("source")}
        >
          source
        </button>
      </div>
      <form.Field name="profileText">
        {(profileField) => (
          <form.Field name="styleText">
            {(styleField) => (
              <form.Field name="templateText">
                {(templateField) =>
                  mode === "fields" ? (
                    <StructuredProfileEditor
                      profileText={profileField.state.value}
                      styleText={styleField.state.value}
                      onProfileTextChange={(value) => profileField.handleChange(value)}
                      onStyleTextChange={(value) => styleField.handleChange(value)}
                    />
                  ) : (
                    <>
                      <Editor
                        dirty={profileField.state.meta.isDirty}
                        label="profile.json"
                        saving={updateProfile.isPending}
                        value={profileField.state.value}
                        onChange={(value) => profileField.handleChange(value)}
                        onDiscard={() => profileField.handleChange(initial.profile ? JSON.stringify(initial.profile, null, 2) : "")}
                        onSave={() => void form.handleSubmit()}
                      />
                      <Editor
                        dirty={styleField.state.meta.isDirty}
                        label="resume_style.json"
                        saving={updateProfile.isPending}
                        value={styleField.state.value}
                        onChange={(value) => styleField.handleChange(value)}
                        onDiscard={() => styleField.handleChange(initial.style ? JSON.stringify(initial.style, null, 2) : "")}
                        onSave={() => void form.handleSubmit()}
                      />
                      <Editor
                        dirty={templateField.state.meta.isDirty}
                        label="resume_template.tex"
                        saving={updateProfile.isPending}
                        value={templateField.state.value}
                        onChange={(value) => templateField.handleChange(value)}
                        onDiscard={() => templateField.handleChange(initial.templateText)}
                        onSave={() => void form.handleSubmit()}
                      />
                    </>
                  )
                }
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
      {updateProfile.error ? (
        <div className="banner inline">{updateProfile.error.message}</div>
      ) : null}
      {!form.state.values.profileText && !form.state.values.styleText ? (
        <Empty title="Loading profile." />
      ) : null}
    </form>
  );
}
