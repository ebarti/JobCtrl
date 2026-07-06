import { ContactImportRequestSchema, type ContactImportRequest } from "@jobhunter/contracts";
import { useForm } from "@tanstack/react-form";
import { useMemo, useState } from "react";

import { Empty } from "../../../shared/ui/empty.js";
import { useImportContactsMutation } from "../hooks/useImportContactsMutation.js";
import { useOutreachImportStore } from "../stores/outreach-import-store.js";

export interface ContactImportWizardProps {
  onDone?: () => void;
}

type WizardStep = "upload" | "preview" | "confirm";

function estimateContactRows(csvText: string): number {
  const rows = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return Math.max(rows.length - 1, 0);
}

export function ContactImportWizard({ onDone }: ContactImportWizardProps) {
  const filename = useOutreachImportStore((state) => state.filename);
  const csvText = useOutreachImportStore((state) => state.csvText);
  const setUpload = useOutreachImportStore((state) => state.setUpload);
  const reset = useOutreachImportStore((state) => state.reset);

  const importContacts = useImportContactsMutation();
  const [step, setStep] = useState<WizardStep>("upload");
  const [statusMessage, setStatusMessage] = useState("");

  const form = useForm({
    defaultValues: { filename, csvText } satisfies ContactImportRequest,
    validators: {
      onSubmit: ({ value }) => {
        const result = ContactImportRequestSchema.safeParse(value);
        return result.success ? undefined : (result.error.issues[0]?.message ?? "Invalid import.");
      },
    },
    onSubmit: ({ value }) => {
      setUpload(value.filename, value.csvText);
      setStatusMessage("");
      setStep("preview");
    },
  });

  const parsedRowCount = useMemo(() => estimateContactRows(csvText), [csvText]);
  const errorMessage = importContacts.error?.message ?? "";

  const confirmImport = async () => {
    setStatusMessage("");
    const response = await importContacts.mutateAsync({ filename, csvText });
    reset();
    setStatusMessage(
      `Imported ${response.imported} contact${response.imported === 1 ? "" : "s"}` +
        (response.skipped ? `, skipped ${response.skipped}.` : "."),
    );
    onDone?.();
  };

  return (
    <div className="contact-import-wizard">
      {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
      {statusMessage ? <div className="status-line">{statusMessage}</div> : null}

      {step === "upload" ? (
        <form
          className="wizard-step"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <form.Field name="filename">
            {(field) => (
              <label className="field">
                <span>List name</span>
                <input
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </label>
            )}
          </form.Field>
          <form.Field name="csvText">
            {(field) => (
              <label className="field">
                <span>CSV rows</span>
                <textarea
                  rows={8}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </label>
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
          <div className="form-actions">
            <button type="submit" className="tab on">
              next
            </button>
          </div>
        </form>
      ) : null}

      {step === "preview" ? (
        <div className="wizard-step">
          {csvText ? (
            <p>
              <b>{filename || "Contact list"}</b> parses to{" "}
              <b>{parsedRowCount}</b> contact{parsedRowCount === 1 ? "" : "s"} (excluding the header
              row).
            </p>
          ) : (
            <Empty title="No CSV provided. Go back to step 1." />
          )}
          <div className="form-actions">
            <button type="button" className="tab" onClick={() => setStep("upload")}>
              back
            </button>
            <button
              type="button"
              className="tab on"
              disabled={!csvText}
              onClick={() => setStep("confirm")}
            >
              next
            </button>
          </div>
        </div>
      ) : null}

      {step === "confirm" ? (
        <div className="wizard-step">
          <p>
            Import <b>{parsedRowCount}</b> contact{parsedRowCount === 1 ? "" : "s"} from{" "}
            <b>{filename || "the pasted list"}</b>. Every imported fact is recorded with imported-list
            provenance.
          </p>
          <div className="form-actions">
            <button type="button" className="tab" onClick={() => setStep("preview")}>
              back
            </button>
            <button
              type="button"
              className="tab on"
              disabled={importContacts.isPending || !csvText}
              onClick={() => void confirmImport()}
            >
              {importContacts.isPending ? "importing" : "confirm import"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
