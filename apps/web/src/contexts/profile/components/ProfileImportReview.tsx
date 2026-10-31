import { JobCtrlApiError } from "@jobctrl/api-client";
import { useEffect, useRef, useState } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { useToastStore } from "../../../shared/stores/toasts.js";
import { Alert, AlertDescription } from "../../../shared/ui/alert.js";
import { Button } from "../../../shared/ui/button.js";
import { useUpdateProfileMutation } from "../hooks/useUpdateProfileMutation.js";
import {
  assertImportAcceptanceAuthority,
  buildImportAcceptance,
  importReviewSections,
  requiresLegacyRereview,
  verifyCanonicalProfile,
  type ImportSection,
} from "../lib/import-review.js";
import { isJsonRecord } from "../lib/json-record.js";
import {
  legacyRecoveryRecord,
  useProfileImportReviewStore,
  type ProfileImportReviewDraft,
} from "../stores/profile-import-review-store.js";

export function ProfileImportReview() {
  const { storage } = usePorts();
  const drafts = useProfileImportReviewStore((state) => state.drafts);
  const storageError = useProfileImportReviewStore((state) => state.storageError);
  const hydrate = useProfileImportReviewStore((state) => state.hydrate);
  const retry = useProfileImportReviewStore((state) => state.retry);
  const tenantId = useTenantId();
  useEffect(() => { void hydrate(storage); }, [hydrate, storage]);
  const visibleDrafts = drafts.filter((draft) => draft.tenantId === tenantId);
  if (!visibleDrafts.length && !storageError) return null;
  return (
    <section
      className="card profile-import-review"
      aria-labelledby="profile-import-review-title"
    >
      <h2 id="profile-import-review-title">Review imported resume</h2>
      <p>
        Review the extracted sections, then select what to save. Imported
        achievements do not become confirmed evidence.
      </p>
      <p className="muted">
        Experience, education and skills are added alongside saved entries.
        Older review data remains available for recovery after a draft is resolved.
      </p>
      {storageError ? <Alert role="status"><AlertDescription>
        Review drafts could not be read or saved in browser storage. Drafts shown only in this session may be lost on reload. Retrying loads the latest stored drafts and clears selections for changed drafts.
        <Button type="button" variant="outline" onClick={() => void retry(storage)}>Retry browser storage</Button>
      </AlertDescription></Alert> : null}
      {visibleDrafts.map((draft) => legacyRecoveryRecord(draft) === null
        ? <ImportReviewDraft key={draft.id} draft={draft} />
        : <LegacyRecovery key={draft.id} draft={draft} />)}
    </section>
  );
}

function LegacyRecovery({ draft }: { draft: ProfileImportReviewDraft }) {
  const { storage } = usePorts();
  const discard = useProfileImportReviewStore((state) => state.discard);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState("");
  const record = legacyRecoveryRecord(draft);
  const unresolved = record === draft;
  return (
    <div className="profile-import-review__draft">
      <h3>Preserved legacy review: {draft.filename}</h3>
      <p>This older review may include fields whose extraction source cannot be verified. It remains in this browser and may contain sensitive profile information. Show the JSON and copy it before clearing site data. Import the PDF again to review source-verified fields.</p>
      {draft.attempt && unresolved ? <p role="status">A previous save was attempted and may have completed. Inspect the saved profile and account for that attempt before starting another import. Removing this review does not cancel a save already in flight.</p> : null}
      {message ? <p role="status">{message}</p> : null}
      <Button type="button" variant="outline" onClick={() => setVisible(!visible)}>
        {visible ? "Hide recovery JSON" : "Show recovery JSON"}
      </Button>
      {visible ? <textarea aria-label="Preserved legacy review JSON" readOnly rows={12} value={JSON.stringify(record, null, 2)} /> : null}
      {unresolved ? <Button type="button" variant="outline" disabled={busy} onClick={() => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        void discard(draft, storage).then((removed) => {
          if (!removed) setMessage("The review could not be removed. Its original data remains available; retry browser storage.");
        }).finally(() => { busyRef.current = false; setBusy(false); });
      }}>{draft.attempt ? "Remove review draft" : "Reject draft"}</Button> : null}
    </div>
  );
}

function ImportReviewDraft({ draft }: { draft: ProfileImportReviewDraft }) {
  const { api, storage } = usePorts();
  // A stale import can fail while another save succeeds. Do not roll an old
  // optimistic snapshot over the newer profile cache on that failure.
  const update = useUpdateProfileMutation({ optimistic: false });
  const discard = useProfileImportReviewStore((state) => state.discard);
  const verify = useProfileImportReviewStore((state) => state.verify);
  const beginAttempt = useProfileImportReviewStore((state) => state.beginAttempt);
  const clearRejectedAttempt = useProfileImportReviewStore((state) => state.clearRejectedAttempt);
  const rebase = useProfileImportReviewStore((state) => state.rebase);
  const [selected, setSelected] = useState<Set<ImportSection>>(() => new Set(draft.attempt?.sections ?? []));
  const reviewedRevision = useRef(draft.revision);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState("");
  const [savedButRetained, setSavedButRetained] = useState(false);
  const sections = importReviewSections(draft);
  const source = isJsonRecord(draft.result.source) ? draft.result.source : {};
  const warnings = Array.isArray(source.warnings)
    ? source.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  useEffect(() => {
    if (reviewedRevision.current !== draft.revision) {
      reviewedRevision.current = draft.revision;
      setSelected(new Set(draft.attempt?.sections ?? []));
    }
  }, [draft.revision, draft.attempt]);

  const toggle = (id: ImportSection, checked: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const accept = async () => {
    if (busyRef.current) return;
    const chosen = draft.attempt?.sections ?? [...selected];
    const isRetry = draft.attempt !== null;
    let marked: ProfileImportReviewDraft | null = null;
    busyRef.current = true;
    setBusy(true);
    setMessage("");
    try {
      if (requiresLegacyRereview(draft)) {
        setMessage(draft.attempt
          ? "This older draft has an unconfirmed save and cannot be retried safely. Inspect the saved profile and preserve the recovery data before removing this review."
          : "This older draft must be reviewed again against the latest saved profile before saving.");
        return;
      }
      try {
        assertImportAcceptanceAuthority(draft, new Set(chosen));
      } catch (error) {
        setMessage(isRetry
          ? "The review data could not be verified. A previous save may have completed; inspect the saved profile and retain the recovery data."
          : error instanceof Error ? error.message : "The review data could not be verified. Your draft remains available for recovery.");
        return;
      }
      if (!(await verify(draft, storage))) {
        setMessage(isRetry
          ? "This saved attempt could not be verified. A previous save may have completed. Inspect the saved profile and resolve browser storage before removing this draft or starting another import."
          : "This draft is not available at the reviewed version. It may have changed or been rejected in another tab, or browser storage may be unavailable. Your selections remain here; check storage and the latest draft before saving.");
        return;
      }
      const canonical = await api.profile();
      if (isRetry && canonical.profileVersion !== draft.attempt?.profileVersion) {
        setMessage("A previous save may have completed and the saved profile has changed. Inspect the saved profile and account for that attempt before removing this draft or starting another import; this draft cannot be retried or rebased safely.");
        return;
      }
      let request;
      try {
        request = buildImportAcceptance(draft, new Set(chosen), canonical);
      } catch (error) {
        setMessage(isRetry
          ? "The original save cannot be retried safely because the review or saved profile could not be verified. A previous save may have completed. Inspect the saved profile and account for that attempt before removing this draft or starting another import."
          : error instanceof Error ? error.message : "The selected sections could not be prepared.");
        return;
      }
      marked = await beginAttempt(draft, chosen, storage);
      if (!marked) {
        setMessage(isRetry
          ? "The original retry could not be recorded. A previous save may have completed. Inspect the saved profile and resolve browser storage before removing this draft or starting another import."
          : "The review attempt could not be recorded. Your draft and selections remain; check browser storage and the latest draft.");
        return;
      }
      await update.mutateAsync(request);
      if (await discard(marked, storage)) {
        useToastStore.getState().toast({ variant: "success", message: "Selected import sections saved." });
      } else {
        setSavedButRetained(true);
        setMessage("Selected sections were saved, but the review draft changed or could not be removed. Check the latest draft and retry removal; do not accept it again.");
      }
    } catch (error) {
      if (error instanceof JobCtrlApiError && error.status === 409
        && isJsonRecord(error.responseBody) && error.responseBody.error === "stale_profile_version") {
        if (!isRetry && marked && await clearRejectedAttempt(marked, storage)) {
          setMessage("The saved profile changed. Your draft is still here; load the latest profile and review your selections again.");
        } else {
          setMessage("A previous save may have completed and the saved profile changed. Inspect the saved profile and account for that attempt before removing this draft or starting another import; this draft cannot be retried or rebased safely.");
        }
      } else {
        setMessage(marked
          ? "The save could not be confirmed. Your draft is still here; retrying the original selection is safe only while the saved profile version is unchanged."
          : "The saved profile could not be loaded. Your draft is unchanged; retry when it is available.");
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const reload = async () => {
    if (busyRef.current || draft.attempt) return;
    busyRef.current = true;
    setBusy(true);
    setMessage("");
    try {
      const latest = await api.profile();
      try {
        verifyCanonicalProfile(latest);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "The saved profile could not be verified. Your draft is unchanged.");
        return;
      }
      if (!(await rebase(draft, latest, storage))) {
        setMessage("The latest profile was loaded, but this review draft changed or could not be saved. Your selections remain here; check the latest draft and browser storage.");
        return;
      }
      setSelected(new Set());
      setMessage(
        "Latest saved profile loaded. Review and select the sections again before saving.",
      );
    } catch {
      setMessage(
        "The saved profile could not be loaded. Your import draft is unchanged; retry when it is available.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="profile-import-review__draft">
      <h3>{draft.filename}</h3>
      <p>
        Based on{" "}
        {draft.base.profileVersion === null
          ? "an empty profile"
          : `saved profile version ${draft.base.profileVersion}`}
        .
      </p>
      {warnings.length ? (
        <Alert role="status">
          <AlertDescription>
            Extraction warnings:
            <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {message ? (
        <Alert role="status">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      {draft.attempt ? <Alert role="status"><AlertDescription>
        A previous save was attempted and may have completed. The original selection can be retried only if the saved profile version is unchanged. Removing this draft does not cancel a save already in flight.
      </AlertDescription></Alert> : null}
      {requiresLegacyRereview(draft) && !draft.attempt ? <Alert role="status"><AlertDescription>
        This older draft must be reviewed again. Load the latest saved profile before accepting it.
      </AlertDescription></Alert> : null}
      {draft.importProfile && !sections.some((section) => section.id !== "style") ? (
        <p>No new profile fields are available for review in this draft.</p>
      ) : null}
      {draft.importStyle && !sections.some((section) => section.id === "style") ? (
        <p>No resume style is available for review in this draft.</p>
      ) : null}
      {sections.length ? (
        <fieldset disabled={busy || draft.attempt !== null}>
          <legend>Choose the sections to save</legend>
          {sections.map((section) => (
            <div key={section.id} className="profile-import-review__section">
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(section.id)}
                  onChange={(event) => toggle(section.id, event.target.checked)}
                />{" "}
                <strong>{section.label}</strong>
              </label>
              <ul>
                {section.lines.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
        </fieldset>
      ) : (
        <p>No reviewable fields were returned for the selected import scope.</p>
      )}
      <div className="form-actions">
        <Button
          type="button"
          disabled={busy || savedButRetained || (!draft.attempt && selected.size === 0)}
          onClick={() => void accept()}
        >
          {busy ? "Working…" : draft.attempt ? "Retry original save" : "Accept selected sections"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || draft.attempt !== null}
          onClick={() => void reload()}
        >
          Load latest saved profile
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            if (busyRef.current) return;
            busyRef.current = true;
            setBusy(true);
            void discard(draft, storage).then((removed) => {
              if (!removed) setMessage("The review draft changed or could not be removed. Your selections remain here; check the latest draft and browser storage.");
            }).finally(() => { busyRef.current = false; setBusy(false); });
          }}
        >
          {savedButRetained ? "Remove saved draft" : draft.attempt ? "Remove review draft" : "Reject draft"}
        </Button>
      </div>
    </div>
  );
}
