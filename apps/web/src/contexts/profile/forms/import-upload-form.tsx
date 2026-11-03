import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { IconFileTypePdf } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import { fileToBase64 } from "../../../shared/lib/file.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Alert, AlertDescription } from "../../../shared/ui/alert.js";
import { Button, buttonVariants } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import {
  hasCompletedImport,
  hasProfileImportUpload,
  useProfileImportStore,
} from "../stores/profile-import-store.js";

interface UploadFormValues {
  filename: string;
  pdfBase64: string;
}

const UploadValidator = z.object({
  filename: z
    .string()
    .trim()
    .min(1, "Choose a PDF before continuing.")
    .max(260),
  pdfBase64: z.string().min(1, "Choose a PDF before continuing."),
});

export function ImportUploadForm() {
  const navigate = useNavigate();
  const router = useRouter();
  const { storage } = usePorts();
  const initialFilename = useProfileImportStore((state) => state.filename);
  const initialPdf = useProfileImportStore((state) => state.pdfBase64);
  const selectionPending = useProfileImportStore(
    (state) => state.selectionPending,
  );
  const storageFailure = useProfileImportStore((state) => state.storageFailure);
  const pendingWrites = useProfileImportStore((state) => state.pendingWrites);
  const legacyRaw = useProfileImportStore((state) => state.legacyRaw);
  const legacyData = useProfileImportStore((state) => state.legacyData);
  const completedImport = useProfileImportStore(hasCompletedImport);
  const beginSelection = useProfileImportStore((state) => state.beginSelection);
  const endSelection = useProfileImportStore((state) => state.endSelection);
  const setUpload = useProfileImportStore((state) => state.setUpload);
  const reset = useProfileImportStore((state) => state.reset);
  const retryStorage = useProfileImportStore((state) => state.retryStorage);

  const [readError, setReadError] = useState("");
  const [reading, setReading] = useState(false);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const loadingSavedRef = useRef(false);
  const [pendingUpload, setPendingUpload] = useState<UploadFormValues | null>(
    null,
  );
  const readGeneration = useRef(0);

  useEffect(() => {
    // The URL can change while the previous route remains mounted. Retire its
    // read before waiting for React's eventual unmount cleanup.
    const unsubscribe = router.subscribe(
      "onBeforeNavigate",
      ({ pathChanged }) => {
        if (pathChanged) {
          readGeneration.current += 1;
          setReading(false);
          setPendingUpload(null);
          setReadError("");
          endSelection();
        }
      },
    );
    return () => {
      unsubscribe();
      readGeneration.current += 1;
      endSelection();
    };
  }, [endSelection, router]);

  const form = useForm({
    defaultValues: {
      filename: initialFilename,
      pdfBase64: initialPdf,
    } satisfies UploadFormValues,
    validators: {
      onSubmit: ({ value }) => {
        const result = UploadValidator.safeParse(value);
        return result.success
          ? undefined
          : (result.error.issues[0]?.message ?? "Invalid upload");
      },
    },
    onSubmit: async ({ value }) => {
      const accepted = useProfileImportStore.getState();
      if (
        !hasProfileImportUpload(accepted) ||
        value.filename !== accepted.filename ||
        value.pdfBase64 !== accepted.pdfBase64
      )
        return;
      await navigate({
        to: completedImport
          ? "/profile/import/confirm"
          : "/profile/import/preview",
      });
    },
  });

  const showAcceptedUpload = (value: UploadFormValues) => {
    form.setFieldValue("filename", value.filename);
    form.setFieldValue("pdfBase64", value.pdfBase64);
  };

  const removeUpload = async () => {
    if (loadingSavedRef.current) return;
    readGeneration.current += 1;
    setReading(false);
    setPendingUpload(null);
    setReadError("");
    beginSelection();
    const generation = readGeneration.current;
    const pathname = router.history.location.pathname;
    if (
      await reset(
        storage,
        () =>
          generation === readGeneration.current &&
          pathname === router.history.location.pathname,
      )
    ) {
      showAcceptedUpload({ filename: "", pdfBase64: "" });
    }
  };

  const retryUpload = async () => {
    const generation = readGeneration.current;
    const pathname = router.history.location.pathname;
    if (
      pendingUpload &&
      (await setUpload(
        pendingUpload.filename,
        pendingUpload.pdfBase64,
        storage,
        () =>
          generation === readGeneration.current &&
          pathname === router.history.location.pathname,
      ))
    ) {
      showAcceptedUpload(pendingUpload);
      setPendingUpload(null);
    }
  };

  const discardSelection = () => {
    readGeneration.current += 1;
    setReading(false);
    setPendingUpload(null);
    setReadError("");
    endSelection();
  };

  const loadSaved = async () => {
    if (loadingSavedRef.current) return;
    loadingSavedRef.current = true;
    setLoadingSaved(true);
    const generation = ++readGeneration.current;
    const pathname = router.history.location.pathname;
    setReading(false);
    setReadError("");
    setPendingUpload(null);
    endSelection();
    const stillCurrent = () =>
      generation === readGeneration.current &&
      pathname === router.history.location.pathname;
    try {
      if (await retryStorage(storage, stillCurrent))
        showAcceptedUpload(useProfileImportStore.getState());
    } finally {
      loadingSavedRef.current = false;
      setLoadingSaved(false);
    }
  };

  const handleFile = async (file: File | null) => {
    const generation = ++readGeneration.current;
    const pathname = router.history.location.pathname;
    setReadError("");
    setPendingUpload(null);
    setReading(false);
    beginSelection();
    if (!file) {
      // Dismissing the native picker is not an explicit removal of the last
      // accepted PDF. The separate removal control handles that operation.
      endSelection();
      return;
    }
    if (
      file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      setReadError("Choose a PDF file.");
      return;
    }
    setReading(true);
    try {
      const pdfBase64 = await fileToBase64(file);
      if (
        generation !== readGeneration.current ||
        pathname !== router.history.location.pathname
      )
        return;
      if (!pdfBase64) {
        setReadError("The selected PDF is empty. Choose another file.");
        return;
      }
      const upload = { filename: file.name, pdfBase64 };
      const accepted = await setUpload(
        upload.filename,
        upload.pdfBase64,
        storage,
        () =>
          generation === readGeneration.current &&
          pathname === router.history.location.pathname,
      );
      if (
        generation !== readGeneration.current ||
        pathname !== router.history.location.pathname
      )
        return;
      if (accepted) showAcceptedUpload(upload);
      else setPendingUpload(upload);
    } catch {
      if (
        generation === readGeneration.current &&
        pathname === router.history.location.pathname
      ) {
        setReadError("Unable to read the selected PDF. Choose it again.");
      }
    } finally {
      if (
        generation === readGeneration.current &&
        pathname === router.history.location.pathname
      )
        setReading(false);
    }
  };

  return (
    <form
      className="wizard-step resume-import-step resume-import-step--upload"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <header className="resume-import-step__header">
        <span className="resume-import-step__eyebrow" data-typography="label">
          Upload PDF
        </span>
        <h2 data-typography="section-title">Choose your source resume</h2>
        <p data-typography="body">
          Select the PDF you want to inspect before deciding which information
          to import.
        </p>
      </header>

      {readError ? (
        <Alert className="resume-import-alert" variant="destructive">
          <AlertDescription>{readError}</AlertDescription>
          {selectionPending && !reading ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={discardSelection}
              >
                {initialFilename && initialPdf
                  ? "Keep previously saved PDF"
                  : "Discard selection"}
              </Button>
            </div>
          ) : null}
        </Alert>
      ) : null}

      {storageFailure ? (
        <Alert className="resume-import-alert" variant="destructive">
          <AlertDescription>
            {storageFailure === "conflict"
              ? "Another tab changed the saved import. This tab did not overwrite it. Load the latest saved PDF before continuing."
              : storageFailure === "read"
                ? "The saved resume could not be read from browser storage. Check site data permissions, then retry or choose a new PDF."
                : storageFailure === "remove"
                  ? "The saved PDF could not be removed from browser storage. Check site data permissions, then retry removal."
                  : `${pendingUpload ? `“${pendingUpload.filename}”` : "The change"} could not be saved in browser storage. Free space or allow site data, then retry. The previously saved PDF, if any, is unchanged.`}
          </AlertDescription>
          <div className="mt-2 flex flex-wrap gap-2">
            {pendingUpload ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void retryUpload()}
              >
                Retry saving PDF
              </Button>
            ) : null}
            {storageFailure === "remove" ? (
              <Button
                type="button"
                variant="outline"
                disabled={loadingSaved}
                onClick={() => void removeUpload()}
              >
                Retry removing PDF
              </Button>
            ) : null}
            {storageFailure === "read" ? (
              <Button
                type="button"
                variant="outline"
                disabled={loadingSaved}
                onClick={() => void loadSaved()}
              >
                Retry browser storage
              </Button>
            ) : null}
            {storageFailure === "conflict" ? (
              <Button
                type="button"
                variant="outline"
                disabled={loadingSaved}
                onClick={() => void loadSaved()}
              >
                Load latest saved PDF
              </Button>
            ) : null}
            {selectionPending && !reading ? (
              <Button
                type="button"
                variant="outline"
                onClick={discardSelection}
              >
                {initialFilename && initialPdf
                  ? "Keep previously saved PDF"
                  : "Discard selection"}
              </Button>
            ) : null}
          </div>
        </Alert>
      ) : null}

      {loadingSaved ? <p role="status">Loading the latest saved PDF…</p> : null}

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

      <form.Field name="filename">
        {(field) => (
          <label
            className="import-target resume-import-target"
            data-ready={Boolean(field.state.value) || undefined}
            aria-busy={reading}
          >
            <span className="resume-import-target__icon" aria-hidden="true">
              <IconFileTypePdf size={30} stroke={1.65} />
            </span>
            <span className="resume-import-target__copy">
              <b data-typography="strong-body">
                {field.state.value ? "PDF selected" : "Choose a resume PDF"}
              </b>
              <small data-typography="metadata" aria-live="polite">
                {reading
                  ? "Reading the selected file…"
                  : field.state.value || "PDF files only"}
              </small>
            </span>
            <Input
              aria-label="Resume PDF"
              type="file"
              accept="application/pdf"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0] ?? null;
                // Allow intentionally retrying the same file after a failure.
                event.currentTarget.value = "";
                void handleFile(file);
              }}
            />
            <span
              className="resume-import-target__action"
              data-typography="control"
              aria-hidden="true"
            >
              {reading
                ? "Reading…"
                : field.state.value
                  ? "Choose another"
                  : "Choose PDF"}
            </span>
          </label>
        )}
      </form.Field>

      <p className="resume-import-step__hint" data-typography="body">
        The selected file is not imported until you review the options and
        confirm the final step. It is saved in this browser for the wizard;
        leaving or cancelling keeps it here until you remove it or complete the
        import.
      </p>

      {legacyRaw !== null ? (
        <p className="resume-import-step__hint" data-typography="body">
          Import data from an earlier JobCtrl version remains in this browser.
          Close or reload older JobCtrl tabs; removing the current upload does
          not delete that earlier copy.
          {legacyData?.filename && legacyData.pdfBase64 ? (
            <>
              {" "}
              <a
                href={`data:application/pdf;base64,${legacyData.pdfBase64}`}
                download={legacyData.filename}
              >
                Download earlier saved PDF
              </a>
              .
            </>
          ) : null}
        </p>
      ) : null}

      {initialFilename && initialPdf && storageFailure !== "remove" ? (
        <Button
          type="button"
          variant="outline"
          disabled={loadingSaved}
          onClick={() => void removeUpload()}
        >
          Remove saved PDF
        </Button>
      ) : null}

      <form.Subscribe
        selector={(state) => ({
          hasUpload: hasProfileImportUpload(state.values),
          isSubmitting: state.isSubmitting,
        })}
      >
        {({ hasUpload, isSubmitting }) => (
          <div className="form-actions resume-import-actions">
            <Button
              type="submit"
              disabled={
                !hasUpload ||
                isSubmitting ||
                reading ||
                selectionPending ||
                storageFailure === "read" ||
                storageFailure === "conflict" ||
                pendingWrites > 0
              }
            >
              {completedImport ? "Continue to cleanup" : "Continue to options"}
            </Button>
            <Link
              className={buttonVariants({ variant: "outline" })}
              to="/profile"
            >
              Cancel
            </Link>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
