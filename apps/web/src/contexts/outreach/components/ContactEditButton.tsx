import { JobCtrlApiError } from "@jobctrl/api-client";
import { ContactAttributeInputSchema, type ContactCreateRequest, type ContactDetail, type ContactUpdateRequest } from "@jobctrl/contracts";
import { useId, useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../../shared/ui/dialog.js";
import { Button } from "../../../shared/ui/button.js";
import { ContactForm, type ContactFormHandle, type ContactFormValues } from "../forms/contact-form.js";
import { useUpdateContactMutation } from "../hooks/useUpdateContactMutation.js";
import { useContactDetailQuery } from "../hooks/useContactDetailQuery.js";
import { ContactProvenanceList } from "./ContactProvenanceList.js";
import { contactRoleLabel } from "../lib/contact-copy.js";
import {
  contactFactsChanged,
  contactFormValues,
  draftFactChanged,
  reconcileContact,
  type ContactReconciliationChoice,
  type ContactReconciliationConflict,
} from "../lib/contact-reconciliation.js";

export interface ContactEditButtonProps {
  contact: ContactDetail;
  label?: string;
  className?: string;
}

export function ContactEditButton({ contact, label = "Edit", className }: ContactEditButtonProps) {
  const choiceGroupId = useId();
  const formRef = useRef<ContactFormHandle>(null);
  const sessionVersion = useRef(0);
  const [open, setOpen] = useState(false);
  const updateContact = useUpdateContactMutation();
  const currentContact = useContactDetailQuery(contact.contactId);
  const [session, setSession] = useState(contact);
  const [base, setBase] = useState(contact);
  const [conflict, setConflict] = useState(false);
  const [savedDuringEdit, setSavedDuringEdit] = useState(false);
  const [latest, setLatest] = useState<ContactDetail | null>(null);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [resolution, setResolution] = useState<{
    draft: ContactFormValues;
    fingerprint: string;
    conflicts: ContactReconciliationConflict[];
  } | null>(null);
  const [choices, setChoices] = useState<Record<string, ContactReconciliationChoice>>({});

  const validateEdit = (draft: ContactFormValues): string | undefined => {
    const saved = new Map(base.attributes.map((fact) => [fact.attributeId, fact]));
    for (const fact of draft.attributes) {
      const original = fact.attributeId !== undefined ? saved.get(fact.attributeId) : undefined;
      if (original && !draftFactChanged(original, fact)) continue;
      if (fact.value.trim() === "") continue;
      if (fact.unsupportedKind) {
        return "This editor cannot change an unsupported saved fact. Your draft is retained; remove it explicitly before adding a supported fact.";
      }
      const parsed = ContactAttributeInputSchema.safeParse({ kind: fact.kind, value: fact.value });
      if (!parsed.success) return parsed.error.issues[0]?.message ?? "Invalid contact fact.";
    }
    return undefined;
  };

  const loadLatest = async () => {
    const version = sessionVersion.current;
    setLoadingLatest(true);
    setReadError(null);
    setResolution(null);
    setChoices({});
    setLatest(null);
    const result = await currentContact.refetch();
    if (sessionVersion.current !== version) return;
    if (result.isSuccess && result.data.contact.contactId === session.contactId) setLatest(result.data.contact);
    else setReadError("Could not load the latest contact. Your draft is retained; try again.");
    setLoadingLatest(false);
  };

  const handleSubmit = async (request: ContactCreateRequest) => {
    if (conflict) return;
    const draft = formRef.current?.getValues();
    if (!draft) return;
    const version = sessionVersion.current;
    const factsChanged = contactFactsChanged(base, draft);
    const body: ContactUpdateRequest = { expectedFingerprint: base.fingerprint };
    if (request.role !== base.role) body.role = request.role;
    if ((request.employer ?? null) !== base.employer) body.employer = request.employer ?? null;
    if ((request.jobId ?? null) !== base.jobId) body.jobId = request.jobId ?? null;
    if (factsChanged) {
      const saved = new Map(base.attributes.map((fact) => [fact.attributeId, fact]));
      body.attributes = draft.attributes.flatMap((fact) => {
        const original = fact.attributeId !== undefined ? saved.get(fact.attributeId) : undefined;
        if (original && !draftFactChanged(original, fact)) {
          return [{ kind: original.kind, value: original.value,
            ...(original.attributeId ? { attributeId: original.attributeId } : {}) }];
        }
        if (fact.value.trim() === "") return [];
        return [{ kind: fact.kind, value: fact.value,
          ...(original?.attributeId ? { attributeId: original.attributeId } : {}) }];
      });
    }
    try {
      await updateContact.mutateAsync({
        contactId: session.contactId,
        body,
      });
      if (sessionVersion.current !== version || !formRef.current) return;
      if (JSON.stringify(formRef.current.getValues()) !== JSON.stringify(draft)) {
        setSavedDuringEdit(true);
        setConflict(true);
        setLatest(null);
        setReadError(null);
        return;
      }
      closeEditor();
    } catch (error) {
      if (sessionVersion.current !== version) return;
      if (error instanceof JobCtrlApiError && error.status === 409) {
        setSavedDuringEdit(false);
        setConflict(true);
        setLatest(null);
      }
      // The mutation renders the failure. Keep the mounted form and pinned
      // snapshot intact through rollback and query invalidation.
    }
  };

  const applyReconciliation = (draft: ContactFormValues, selected: Record<string, ContactReconciliationChoice>) => {
    if (!latest || !formRef.current) return;
    const result = reconcileContact(base, draft, latest, selected);
    formRef.current.setValues(result.values);
    setBase(latest);
    setConflict(false);
    setSavedDuringEdit(false);
    setLatest(null);
    setResolution(null);
    setChoices({});
    updateContact.reset();
  };

  const beginReconciliation = () => {
    const draft = formRef.current?.getValues();
    if (!latest || !draft) return;
    setReadError(null);
    const result = reconcileContact(base, draft, latest);
    if (result.conflicts.length === 0) {
      applyReconciliation(draft, {});
      return;
    }
    setChoices({});
    setResolution({ draft, fingerprint: latest.fingerprint, conflicts: result.conflicts });
  };

  const applyChoices = () => {
    const draft = formRef.current?.getValues();
    if (!latest || !draft || !resolution) return;
    if (latest.fingerprint !== resolution.fingerprint || JSON.stringify(draft) !== JSON.stringify(resolution.draft)) {
      setResolution(null);
      setChoices({});
      setReadError("Your draft or the loaded contact changed. Review the changes again before applying choices.");
      return;
    }
    if (resolution.conflicts.some((item) => !choices[item.key])) return;
    applyReconciliation(draft, choices);
  };

  const errorMessage = updateContact.error?.message;
  const closeEditor = () => {
    sessionVersion.current += 1;
    setOpen(false);
    updateContact.reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        sessionVersion.current += 1;
        if (next) {
          setSession(contact);
          setBase(contact);
          setConflict(false);
          setSavedDuringEdit(false);
          setLatest(null);
          setLoadingLatest(false);
          setReadError(null);
          setResolution(null);
          setChoices({});
          updateContact.reset();
        }
        setOpen(next);
        if (!next) {
          updateContact.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" {...(className ? { className } : {})}>
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit contact</DialogTitle>
          <DialogDescription>
            Update this contact. Fact provenance is recorded server-side on save.
          </DialogDescription>
        </DialogHeader>
        {conflict ? (
          <section aria-label="Contact save conflict" className="min-w-0 break-words">
            <p role="alert">{savedDuringEdit
              ? "Your submitted changes were saved. Newer edits are retained below. Load the latest record and reconcile them before saving again."
              : "This contact changed. Your draft is retained below. Load the latest record and reconcile your changes before saving again."}</p>
            <Button type="button" variant="outline" disabled={loadingLatest} onClick={() => void loadLatest()}>
              {loadingLatest ? "Loading…" : "Load latest contact"}
            </Button>
            {readError ? <p role="alert">{readError}</p> : null}
            {latest ? (
              <div>
                <h3>Latest saved contact</h3>
                <dl>
                  <dt>Role</dt><dd>{contactRoleLabel(latest.role)}</dd>
                  <dt>Employer</dt><dd>{latest.employer ?? "None"}</dd>
                  <dt>Job</dt><dd>{latest.jobId ?? "None"}</dd>
                </dl>
                <ContactProvenanceList attributes={latest.attributes} />
                <Button type="button" className="h-auto whitespace-normal text-left" onClick={beginReconciliation}>Reconcile changes</Button>
                {resolution ? (
                  <div>
                    <p>Choose which version to keep for each conflicting change. Other newer facts are retained.</p>
                    {resolution.conflicts.some((item) => item.key.startsWith("added:")) ? (
                      <p>A draft-changed fact disappeared while new facts appeared. Their relationship is unknown; choose whether to keep each new fact.</p>
                    ) : null}
                    {resolution.conflicts.map((item, index) => (
                      <fieldset key={item.key}>
                        <legend>{item.label}</legend>
                        <label>
                          <input type="radio" name={`${choiceGroupId}-${index}`} aria-label={`${item.draftAction ?? "Keep my draft"} for ${item.label}`}
                            checked={choices[item.key] === "draft"}
                            onChange={() => setChoices((current) => ({ ...current, [item.key]: "draft" }))} />
                          {item.draftAction ?? "Keep my draft"}: {item.draft}
                        </label>
                        <label>
                          <input type="radio" name={`${choiceGroupId}-${index}`} aria-label={`${item.latestAction ?? "Keep latest"} for ${item.label}`}
                            checked={choices[item.key] === "latest"}
                            onChange={() => setChoices((current) => ({ ...current, [item.key]: "latest" }))} />
                          {item.latestAction ?? "Keep latest"}: {item.latest}
                        </label>
                      </fieldset>
                    ))}
                    <Button type="button" disabled={resolution.conflicts.some((item) => !choices[item.key])} onClick={applyChoices}>Apply choices</Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}
        <ContactForm
          ref={formRef}
          submitLabel="save contact"
          pending={updateContact.isPending}
          saveBlocked={conflict}
          {...(errorMessage ? { errorMessage } : {})}
          initialValues={contactFormValues(session)}
          validateEdit={validateEdit}
          onSubmit={handleSubmit}
          onCancel={closeEditor}
        />
      </DialogContent>
    </Dialog>
  );
}
