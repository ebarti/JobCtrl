import {
  ProfileImportRequestSchema,
  type ProfileImportRequest,
} from "@jobctrl/contracts";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { IconCheck, IconFileTypePdf, IconMinus } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { Alert, AlertDescription } from "../../../shared/ui/alert.js";
import { Button, buttonVariants } from "../../../shared/ui/button.js";
import { Empty } from "../../../shared/ui/empty.js";
import { useImportResumeMutation } from "../hooks/useImportResumeMutation.js";
import { hasVerifiedPersonalSource, hasVerifiedStyleSource, importReviewSections, projectImportReview } from "../lib/import-review.js";
import { useProfileImportReviewStore } from "../stores/profile-import-review-store.js";
import {
  hasCompletedImport,
  hasPendingImport,
  useProfileImportStore,
} from "../stores/profile-import-store.js";

export function ImportConfirmForm() {
  const navigate = useNavigate();
  const router = useRouter();
  const { api, storage } = usePorts();
  const tenantId = useTenantId();
  const filename = useProfileImportStore((state) => state.filename);
  const pdfBase64 = useProfileImportStore((state) => state.pdfBase64);
  const importProfile = useProfileImportStore((state) => state.importProfile);
  const importStyle = useProfileImportStore((state) => state.importStyle);
  const reset = useProfileImportStore((state) => state.reset);
  const storageFailure = useProfileImportStore((state) => state.storageFailure);
  const completedImport = useProfileImportStore(hasCompletedImport);
  const importPending = useProfileImportStore(hasPendingImport);
  const beginImport = useProfileImportStore((state) => state.beginImport);
  const finishImport = useProfileImportStore((state) => state.finishImport);
  const navigationGeneration = useRef(0);
  const navigationAbort = useRef(new AbortController());

  const importResume = useImportResumeMutation();
  const [statusMessage, setStatusMessage] = useState("");
  const [reviewAvailable, setReviewAvailable] = useState(false);

  useEffect(() => {
    navigationAbort.current = new AbortController();
    const unsubscribe = router.subscribe(
      "onBeforeNavigate",
      ({ pathChanged }) => {
        if (pathChanged) {
          navigationGeneration.current += 1;
          navigationAbort.current.abort();
          navigationAbort.current = new AbortController();
        }
      },
    );
    return () => {
      unsubscribe();
      navigationGeneration.current += 1;
      navigationAbort.current.abort();
    };
  }, [router]);

  const form = useForm({
    defaultValues: {
      filename,
      pdfBase64,
      importProfile,
      importStyle,
    } satisfies ProfileImportRequest,
    validators: {
      onSubmit: ({ value }) => {
        const result = ProfileImportRequestSchema.safeParse(value);
        return result.success
          ? undefined
          : (result.error.issues[0]?.message ?? "Invalid import");
      },
    },
    onSubmit: async ({ value }) => {
      const current = useProfileImportStore.getState();
      const revision = current.selectionRevision;
      const generation = navigationGeneration.current;
      const pathname = router.history.location.pathname;
      if (
        value.filename !== current.filename ||
        value.pdfBase64 !== current.pdfBase64 ||
        value.importProfile !== current.importProfile ||
        value.importStyle !== current.importStyle
      )
        return;
      if (!(await beginImport(revision, storage))) return;
      if (
        generation !== navigationGeneration.current ||
        pathname !== router.history.location.pathname
      ) {
        finishImport(revision);
        return;
      }
      setStatusMessage("");
      let response;
      try {
        // Bind the review to the canonical version before the importer reads
        // its base. A concurrent save during extraction will then conflict.
        const base = await api.profile();
        if (
          generation !== navigationGeneration.current ||
          pathname !== router.history.location.pathname
        ) {
          finishImport(revision);
          return;
        }
        response = await importResume.mutateAsync(value);
        if (value.importProfile && !hasVerifiedPersonalSource({ profile: response.profile, source: response.source })) {
          finishImport(revision);
          setStatusMessage("The extracted personal fields could not be verified. Your saved PDF and earlier review drafts remain available; retry extraction.");
          return;
        }
        if (value.importStyle && !hasVerifiedStyleSource({ style: response.style, source: response.source })) {
          finishImport(revision);
          setStatusMessage("The extracted style could not be verified. Your saved PDF and earlier review drafts remain available; retry extraction.");
          return;
        }
        const draft = projectImportReview({
          tenantId,
          filename: value.filename,
          importProfile: value.importProfile,
          importStyle: value.importStyle,
          result: { profile: response.profile, style: response.style, source: response.source },
          base,
        });
        if (!importReviewSections({ ...draft, id: "preview", revision: 0, attempt: null }).length) {
          finishImport(revision);
          if (generation === navigationGeneration.current && pathname === router.history.location.pathname) {
            setStatusMessage("No new reviewable fields were found. Your saved PDF remains available; retry extraction or change the selected scope.");
          }
          return;
        }
        if (!(await useProfileImportReviewStore.getState().stage(draft, storage))) {
          finishImport(revision);
          setReviewAvailable(true);
          setStatusMessage("The extracted draft could not be saved for reload. Your PDF and any earlier drafts remain available; check Profile and retry browser storage or import again.");
          return;
        }
      } catch (error) {
        finishImport(revision);
        setStatusMessage("The import could not be completed. Your saved PDF and any earlier review drafts are still available; retry when Profile and extraction are available.");
        return;
      }
      finishImport(revision, response);
      const latest = useProfileImportStore.getState();
      if (
        generation !== navigationGeneration.current ||
        pathname !== router.history.location.pathname
      )
        return;
      if (latest.selectionRevision !== revision || latest.selectionPending) {
        setStatusMessage(
          "The import request for the previous PDF completed. Your newer selection was kept.",
        );
        return;
      }
      setStatusMessage("Extraction complete. Review the draft in Profile; no profile changes have been saved.");
      if (
        !(await reset(
          storage,
          () =>
            generation === navigationGeneration.current &&
            pathname === router.history.location.pathname,
          navigationAbort.current.signal,
        ))
      ) {
        if (
          generation !== navigationGeneration.current ||
          pathname !== router.history.location.pathname
        )
          return;
        setStatusMessage(
          useProfileImportStore.getState().storageFailure === "conflict"
            ? "The import request completed. Another tab changed the saved PDF, so its newer selection was kept. Return to upload and load the latest saved PDF."
            : "The import request completed, but the PDF is still saved in this browser. Retry removing it or return to Profile; you do not need to submit the import again.",
        );
        return;
      }
      if (
        generation !== navigationGeneration.current ||
        pathname !== router.history.location.pathname
      )
        return;
      await navigate({ to: "/profile" });
    },
  });

  useEffect(() => {
    form.reset({ filename, pdfBase64, importProfile, importStyle });
  }, [form, filename, pdfBase64, importProfile, importStyle]);

  if (!filename || !pdfBase64) {
    return (
      <div className="wizard-step resume-import-step resume-import-empty-step">
        <Empty title="No upload found. Start at step 1." />
        <div className="form-actions resume-import-actions">
          <Link className={buttonVariants()} to="/profile/import/upload">
            Return to upload
          </Link>
        </div>
      </div>
    );
  }

  const errorMessage = importResume.error?.message ?? "";
  const summary =
    importProfile && importStyle
      ? "Profile and style"
      : importProfile
        ? "Profile only"
        : importStyle
          ? "Style only"
          : "No sections selected";

  return (
    <form
      className="wizard-step resume-import-step resume-import-step--confirm"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <header className="resume-import-step__header">
        <span className="resume-import-step__eyebrow" data-typography="label">
          Confirm import
        </span>
        <h2 data-typography="section-title">Review the final import</h2>
        <p data-typography="body">
          Check the source and selected scope before extracting a draft. You
          will review and choose what to save afterward.
        </p>
      </header>

      {errorMessage ? (
        <Alert className="resume-import-alert" variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}
      {storageFailure === "conflict" || storageFailure === "read" ? (
        <Alert className="resume-import-alert" variant="destructive">
          <AlertDescription>
            {storageFailure === "conflict"
              ? "Another tab changed the saved PDF. Return to upload and load the latest saved PDF."
              : "The saved PDF could not be read. Return to upload and retry browser storage."}
          </AlertDescription>
          <Link
            className={buttonVariants({ variant: "outline" })}
            to="/profile/import/upload"
          >
            Return to upload
          </Link>
        </Alert>
      ) : null}
      {statusMessage || completedImport ? (
        <Alert className="resume-import-status" role="status">
          <AlertDescription>
            {statusMessage ||
              "The import request completed. The PDF is still saved in this browser. Remove it or return to Profile; you do not need to submit the import again."}
          </AlertDescription>
        </Alert>
      ) : null}

      <form.Subscribe selector={(state) => state.errors}>
        {(errors) => {
          const message = errors
            .flat()
            .find(
              (entry): entry is string =>
                typeof entry === "string" && entry.length > 0,
            );
          return message ? (
            <Alert className="resume-import-alert" variant="destructive">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null;
        }}
      </form.Subscribe>

      <dl className="resume-import-confirmation-summary">
        <div>
          <dt data-typography="label">Source PDF</dt>
          <dd data-typography="strong-body">
            <IconFileTypePdf size={20} stroke={1.65} aria-hidden="true" />
            <span>{filename}</span>
          </dd>
        </div>
        <div>
          <dt data-typography="label">Import scope</dt>
          <dd data-typography="strong-body">{summary}</dd>
        </div>
      </dl>

      <div
        className="resume-import-scope-review"
        role="group"
        aria-label="Selected import sections"
      >
        <div data-selected={importProfile || undefined}>
          {importProfile ? (
            <IconCheck size={18} stroke={2} aria-hidden="true" />
          ) : (
            <IconMinus size={18} stroke={2} aria-hidden="true" />
          )}
          <span>
            <strong data-typography="strong-body">Profile data</strong>
            <small data-typography="metadata">
              {importProfile ? "Included in this import" : "Not selected"}
            </small>
          </span>
        </div>
        <div data-selected={importStyle || undefined}>
          {importStyle ? (
            <IconCheck size={18} stroke={2} aria-hidden="true" />
          ) : (
            <IconMinus size={18} stroke={2} aria-hidden="true" />
          )}
          <span>
            <strong data-typography="strong-body">Style data</strong>
            <small data-typography="metadata">
              {importStyle ? "Included in this import" : "Not selected"}
            </small>
          </span>
        </div>
      </div>

      {completedImport ? (
        <div className="form-actions resume-import-actions">
          <Button
            type="button"
            onClick={() => {
              const generation = navigationGeneration.current;
              const pathname = router.history.location.pathname;
              void (async () => {
                if (
                  await reset(
                    storage,
                    () =>
                      generation === navigationGeneration.current &&
                      pathname === router.history.location.pathname,
                    navigationAbort.current.signal,
                  )
                ) {
                  if (
                    generation === navigationGeneration.current &&
                    pathname === router.history.location.pathname
                  )
                    await navigate({ to: "/profile" });
                } else if (
                  generation === navigationGeneration.current &&
                  pathname === router.history.location.pathname
                )
                  setStatusMessage(
                    useProfileImportStore.getState().storageFailure ===
                      "conflict"
                      ? "The import request completed. Another tab changed the saved PDF, so its newer selection was kept. Return to upload and load the latest saved PDF."
                      : "The import request completed, but the PDF could not be removed. Check browser site data permissions and retry, or return to Profile without resubmitting.",
                  );
              })();
            }}
          >
            {storageFailure === "remove"
              ? "Retry removing saved PDF"
              : "Remove saved PDF"}
          </Button>
          <Link
            className={buttonVariants({ variant: "outline" })}
            to="/profile"
          >
            Return to profile
          </Link>
        </div>
      ) : (
        <form.Subscribe
          selector={(state) => ({
            canSubmit: state.canSubmit,
            isSubmitting: state.isSubmitting,
          })}
        >
          {({ canSubmit, isSubmitting }) => (
            <div className="form-actions resume-import-actions">
              <Button
                type="submit"
                disabled={
                  !canSubmit ||
                  isSubmitting ||
                  importPending ||
                  storageFailure === "conflict" ||
                  storageFailure === "read"
                }
              >
                {isSubmitting || importPending
                  ? "Importing…"
                  : "Confirm import"}
              </Button>
              <Link
                className={buttonVariants({ variant: "outline" })}
                to="/profile/import/preview"
              >
                Back
              </Link>
              {reviewAvailable ? <Link className={buttonVariants({ variant: "outline" })} to="/profile">Review draft</Link> : null}
            </div>
          )}
        </form.Subscribe>
      )}
    </form>
  );
}
