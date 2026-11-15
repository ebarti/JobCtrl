import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";

const AUTOSAVE_DELAY_MS = 5_000;
const MAX_UNDO_DEPTH = 50;

export interface AutosaveUndoControllerHandle {
  requestSave(): void;
}

export interface AutosaveUndoControllerProps<TValues> {
  readonly formRef: RefObject<HTMLFormElement | null>;
  readonly isDirty: boolean;
  readonly isSubmitting: boolean;
  readonly resetToken: number;
  readonly restoreValues: (values: TValues) => void;
  readonly setStatusMessage: (message: string) => void;
  /** Optional explicit requests share this controller's attempt and timer policy. */
  readonly onControllerChange?: (controller: AutosaveUndoControllerHandle | null) => void;
  /** Explicit false means no confirmed save authority; existing void callers retain their policy. */
  readonly submit: () => Promise<void | boolean>;
  readonly values: TValues;
}

export function AutosaveUndoController<TValues>({
  formRef,
  isDirty,
  isSubmitting,
  resetToken,
  restoreValues,
  setStatusMessage,
  onControllerChange,
  submit,
  values,
}: AutosaveUndoControllerProps<TValues>) {
  const serializedValues = useMemo(() => stableStringify(values), [values]);
  const currentSerializedRef = useRef(serializedValues);
  const currentValuesRef = useRef(cloneValues(values));
  const undoStackRef = useRef<TValues[]>([]);
  const suppressHistoryOnceRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSubmittedValuesRef = useRef<string | null>(null);
  const restoreValuesRef = useRef(restoreValues);
  const setStatusMessageRef = useRef(setStatusMessage);
  const submitRef = useRef(submit);
  const latestSerializedRef = useRef(serializedValues);
  latestSerializedRef.current = serializedValues;
  const submittingRef = useRef(isSubmitting);
  submittingRef.current = isSubmitting;
  const submissionPendingRef = useRef(false);
  const queuedExplicitSaveRef = useRef(false);
  const mountedRef = useRef(true);
  const [submissionEpoch, setSubmissionEpoch] = useState(0);
  const runSubmitRef = useRef<() => void>(() => undefined);
  runSubmitRef.current = () => {
    if (submissionPendingRef.current || submittingRef.current) return;
    clearAutosaveTimer(timerRef);
    lastSubmittedValuesRef.current = latestSerializedRef.current;
    submissionPendingRef.current = true;
    void (async () => {
      let confirmed = false;
      let outcomeReported = false;
      try {
        const result = await submitRef.current();
        outcomeReported = typeof result === "boolean";
        confirmed = result !== false;
      }
      catch {
        if (mountedRef.current) setStatusMessageRef.current("Could not autosave changes. Your draft is still unsaved; try again.");
      } finally {
        submissionPendingRef.current = false;
        if (!mountedRef.current) return;
        if (!confirmed) {
          // A failure cannot authorize a queued write. Confirmed-outcome
          // owners also suppress delayed retry of the latest retained draft;
          // legacy void callers keep their pre-submit attempt marker on throw.
          queuedExplicitSaveRef.current = false;
          if (outcomeReported || onControllerChange !== undefined) {
            lastSubmittedValuesRef.current = latestSerializedRef.current;
          }
          clearAutosaveTimer(timerRef);
        }
        setSubmissionEpoch((epoch) => epoch + 1);
      }
    })();
  };
  const controller = useMemo<AutosaveUndoControllerHandle>(() => ({
    requestSave() {
      if (!mountedRef.current) return;
      queuedExplicitSaveRef.current = true;
      clearAutosaveTimer(timerRef);
      setSubmissionEpoch((epoch) => epoch + 1);
    },
  }), []);

  useEffect(() => {
    onControllerChange?.(controller);
    return () => onControllerChange?.(null);
  }, [controller, onControllerChange]);

  useEffect(() => {
    restoreValuesRef.current = restoreValues;
    setStatusMessageRef.current = setStatusMessage;
    submitRef.current = submit;
  }, [restoreValues, setStatusMessage, submit]);

  useEffect(() => {
    clearAutosaveTimer(timerRef);
    undoStackRef.current = [];
    lastSubmittedValuesRef.current = null;
    queuedExplicitSaveRef.current = false;
    currentSerializedRef.current = serializedValues;
    currentValuesRef.current = cloneValues(values);
  }, [resetToken]);

  useEffect(() => {
    if (serializedValues !== currentSerializedRef.current) {
      if (suppressHistoryOnceRef.current) {
        suppressHistoryOnceRef.current = false;
      } else {
        pushUndoValue(undoStackRef.current, currentValuesRef.current);
      }
      currentSerializedRef.current = serializedValues;
      currentValuesRef.current = cloneValues(values);
    }

    clearAutosaveTimer(timerRef);
    if (isSubmitting || submissionPendingRef.current) return undefined;
    if (!isDirty) {
      lastSubmittedValuesRef.current = null;
      queuedExplicitSaveRef.current = false;
      return undefined;
    }
    if (queuedExplicitSaveRef.current) {
      queuedExplicitSaveRef.current = false;
      runSubmitRef.current();
      return undefined;
    }
    if (serializedValues === lastSubmittedValuesRef.current) {
      return undefined;
    }

    timerRef.current = setTimeout(() => {
      // The form may handle a failed submit without rejecting its promise.
      // Attempt each unchanged draft only once automatically; explicit Save
      // remains available and a different draft may schedule another attempt.
      setStatusMessageRef.current("autosaving changes");
      runSubmitRef.current();
    }, AUTOSAVE_DELAY_MS);

    return () => clearAutosaveTimer(timerRef);
  }, [isDirty, isSubmitting, serializedValues, values, submissionEpoch]);

  useEffect(() => {
    const formElement = formRef.current;
    if (!formElement) {
      return undefined;
    }
    const onSubmit = (event: Event) => {
      if (event.target !== formElement) return;
      clearAutosaveTimer(timerRef);
      lastSubmittedValuesRef.current = latestSerializedRef.current;
    };
    formElement.addEventListener("submit", onSubmit);
    return () => formElement.removeEventListener("submit", onSubmit);
  }, [formRef]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isUndoShortcut(event)) {
        return;
      }
      const formElement = formRef.current;
      const target = event.target;
      if (!formElement || !(target instanceof Node) || !formElement.contains(target)) {
        return;
      }
      if (isNativeUndoTarget(target)) {
        return;
      }
      const previousValues = undoStackRef.current.pop();
      if (!previousValues) {
        return;
      }
      event.preventDefault();
      suppressHistoryOnceRef.current = true;
      clearAutosaveTimer(timerRef);
      restoreValuesRef.current(previousValues);
      setStatusMessageRef.current("changes reverted");
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [formRef]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; queuedExplicitSaveRef.current = false; clearAutosaveTimer(timerRef); };
  }, []);

  return null;
}

function pushUndoValue<TValues>(stack: TValues[], value: TValues): void {
  const serializedValue = stableStringify(value);
  const previousValue = stack.at(-1);
  if (previousValue && stableStringify(previousValue) === serializedValue) {
    return;
  }
  stack.push(cloneValues(value));
  if (stack.length > MAX_UNDO_DEPTH) {
    stack.shift();
  }
}

function clearAutosaveTimer(timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>): void {
  if (!timerRef.current) {
    return;
  }
  clearTimeout(timerRef.current);
  timerRef.current = null;
}

function isUndoShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "z";
}

function isNativeUndoTarget(target: EventTarget): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) {
    return true;
  }
  if (!(target instanceof HTMLInputElement)) {
    return false;
  }
  return !["button", "checkbox", "color", "file", "radio", "range", "reset", "submit"].includes(target.type);
}

function cloneValues<TValues>(values: TValues): TValues {
  return JSON.parse(stableStringify(values)) as TValues;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}
