import { ContactImportRequestSchema } from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useId, useState } from "react";

import type { ContactImportFormat, ContactImportResponse } from "../../operations/types.js";

import { Button } from "../../../shared/ui/button.js";
import { Empty } from "../../../shared/ui/empty.js";
import { Field, FieldLabel } from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../shared/ui/select.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import { useImportContactsMutation } from "../hooks/useImportContactsMutation.js";
import { useOutreachImportStore } from "../stores/outreach-import-store.js";

export interface ContactImportWizardProps {
  onDone?: () => void;
}

type WizardStep = "upload" | "preview" | "confirm";
interface ContactImportFormValues {
  filename: string;
  format: ContactImportFormat;
  content: string;
}

const FACT_LABELS: Record<string, string> = {
  name: "Name",
  title: "Title",
  email: "Email",
  phone: "Phone",
  profile_url: "Profile URL",
  note: "Note",
};

export function ContactImportWizard({ onDone }: ContactImportWizardProps) {
  const formId = useId();
  const filename = useOutreachImportStore((state) => state.filename);
  const format = useOutreachImportStore((state) => state.format);
  const content = useOutreachImportStore((state) => state.content);
  const setUpload = useOutreachImportStore((state) => state.setUpload);
  const reset = useOutreachImportStore((state) => state.reset);

  const importContacts = useImportContactsMutation();
  const [step, setStep] = useState<WizardStep>("upload");
  const [selectedFormat, setSelectedFormat] = useState<ContactImportFormat>(format);
  const [preview, setPreview] = useState<ContactImportResponse | null>(null);
  const [statusMessage, setStatusMessage] = useState("");

  const form = useForm({
    defaultValues: { filename, format, content } satisfies ContactImportFormValues,
    validators: {
      onSubmit: ({ value }) => {
        const result = ContactImportRequestSchema.safeParse({ ...value, mode: "preview" });
        return result.success ? undefined : (result.error.issues[0]?.message ?? "Invalid import.");
      },
    },
    onSubmit: async ({ value }) => {
      setUpload(value.format, value.filename, value.content);
      setStatusMessage("");
      try {
        const response = await importContacts.mutateAsync({ ...value, mode: "preview" });
        setPreview(response);
        setStep("preview");
      } catch {
        // The mutation exposes its bounded request error in the banner below.
      }
    },
  });

  const errorMessage = importContacts.error?.message ?? "";

  const confirmImport = async () => {
    setStatusMessage("");
    try {
      const response = await importContacts.mutateAsync({ filename, format, content, mode: "commit" });
      reset();
      setStatusMessage(
        `Imported ${response.imported} contact${response.imported === 1 ? "" : "s"}` +
          (response.skipped ? `, skipped ${response.skipped}.` : "."),
      );
      onDone?.();
    } catch {
      // The mutation exposes its bounded request error in the banner below.
    }
  };

  return (
    <div className="contact-import-wizard min-w-0 max-w-full">
      {errorMessage ? <div className="banner inline" role="alert">{errorMessage}</div> : null}
      {statusMessage ? <div className="status-line" role="status">{statusMessage}</div> : null}

      {step === "upload" ? (
        <form
          className="wizard-step"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <form.Field name="format">
            {(field) => (
              <Field className="field">
                <FieldLabel htmlFor={`${formId}-format`}>File format</FieldLabel>
                <Select
                  value={field.state.value}
                  onValueChange={(value) => {
                    const nextFormat = value as ContactImportFormat;
                    field.handleChange(nextFormat);
                    setSelectedFormat(nextFormat);
                  }}
                >
                  <SelectTrigger id={`${formId}-format`} aria-label="File format" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="csv">CSV</SelectItem>
                      <SelectItem value="vcard">vCard 3.0 or 4.0</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            )}
          </form.Field>
          <form.Field name="filename">
            {(field) => (
              <Field className="field">
                <FieldLabel htmlFor={`${formId}-filename`}>Source filename</FieldLabel>
                <Input
                  id={`${formId}-filename`}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="content">
            {(field) => (
              <Field className="field">
                <FieldLabel htmlFor={`${formId}-content`}>
                  {selectedFormat === "vcard" ? "vCard content" : "CSV rows"}
                </FieldLabel>
                <Textarea
                  id={`${formId}-content`}
                  rows={10}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.errors}>
            {(errors) => {
              const message = errors.flat().filter((entry): entry is string => typeof entry === "string").at(0);
              return message ? <div className="banner inline" role="alert">{message}</div> : null;
            }}
          </form.Subscribe>
          <div className="form-actions">
            <Button type="submit" disabled={importContacts.isPending}>
              {importContacts.isPending ? "Previewing…" : "Preview import"}
            </Button>
          </div>
        </form>
      ) : null}

      {step === "preview" ? (
        <div className="wizard-step min-w-0 max-w-full">
          {preview ? (
            <>
              <p role="status">
                <b>{preview.summary.ready}</b> ready, <b>{preview.summary.duplicates}</b> duplicate,{
                " "}<b>{preview.summary.invalid}</b> invalid. Unsupported fields are reported on{
                " "}<b>{preview.summary.unsupported}</b> contact{preview.summary.unsupported === 1 ? "" : "s"}.
              </p>
              <ol
                aria-label="Contact import preview"
                className="w-full min-w-0 max-w-full max-h-[45dvh] overflow-y-auto break-words pr-2 [overflow-wrap:anywhere]"
                tabIndex={0}
              >
                {preview.items.map((item) => (
                  <li className="min-w-0 max-w-full" key={item.index}>
                    <p><b>{item.displayName || `Contact ${item.index}`}</b> <span className="meta">{item.status}</span></p>
                    <p className="meta">
                      Employer: {item.employer ?? "None"}{item.jobId ? ` · Job: ${item.jobId}` : ""}
                    </p>
                    {item.attributes.length ? (
                      <ul>
                        {item.attributes.map((attribute, attributeIndex) => (
                          <li key={`${attribute.kind}-${attributeIndex}`}>
                            <b>{FACT_LABELS[attribute.kind] ?? attribute.kind}:</b> {attribute.value}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {item.duplicate ? (
                      <p className="meta">
                        Duplicate of {item.duplicate.scope === "existing"
                          ? `existing contact ${item.duplicate.contactId ?? ""}`
                          : `item ${item.duplicate.itemIndex ?? ""}`}.
                      </p>
                    ) : null}
                    {item.issues.length ? (
                      <ul aria-label={`Issues for contact ${item.index}`}>
                        {item.issues.map((issue, issueIndex) => (
                          <li key={`${issue.code}-${issueIndex}`}>{issue.message}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <Empty title="No server preview is available. Go back and preview the import again." />
          )}
          <div className="form-actions">
            <Button type="button" variant="outline" onClick={() => setStep("upload")}>Back</Button>
            <Button type="button" disabled={!preview || preview.summary.ready === 0} onClick={() => setStep("confirm")}>
              Continue
            </Button>
          </div>
        </div>
      ) : null}

      {step === "confirm" ? (
        <div className="wizard-step">
          <p>
            Import <b>{preview?.summary.ready ?? 0}</b> reviewed contact{
              preview?.summary.ready === 1 ? "" : "s"} from <b>{filename}</b>. Duplicate and invalid
            contacts remain skipped. Every imported fact keeps this filename as imported-list provenance.
          </p>
          <div className="form-actions">
            <Button type="button" variant="outline" onClick={() => setStep("preview")}>Back</Button>
            <Button
              type="button"
              disabled={importContacts.isPending || !preview || preview.summary.ready === 0}
              onClick={() => void confirmImport()}
            >
              {importContacts.isPending ? "Importing…" : "Confirm import"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
