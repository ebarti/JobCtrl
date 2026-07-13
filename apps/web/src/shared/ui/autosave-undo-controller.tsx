import { useEffect, useMemo, useRef, type MutableRefObject, type RefObject } from "react";

const AUTOSAVE_DELAY_MS = 5_000;
const MAX_UNDO_DEPTH = 50;

export interface AutosaveUndoControllerProps<TValues> {
  readonly formRef: RefObject<HTMLFormElement | null>;
  readonly isDirty: boolean;
  readonly isSubmitting: boolean;
  readonly resetToken: number;
  readonly restoreValues: (values: TValues) => void;
  readonly setStatusMessage: (message: string) => void;
  readonly submit: () => Promise<void>;
  readonly values: TValues;
}

export function AutosaveUndoController<TValues>({
  formRef,
  isDirty,
  isSubmitting,
  resetToken,
  restoreValues,
  setStatusMessage,
  submit,
  values,
}: AutosaveUndoControllerProps<TValues>) {
  const serializedValues = useMemo(() => stableStringify(values), [values]);
  const currentSerializedRef = useRef(serializedValues);
  const currentValuesRef = useRef(cloneValues(values));
  const undoStackRef = useRef<TValues[]>([]);
  const suppressHistoryOnceRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreValuesRef = useRef(restoreValues);
  const setStatusMessageRef = useRef(setStatusMessage);
  const submitRef = useRef(submit);

  useEffect(() => {
    restoreValuesRef.current = restoreValues;
    setStatusMessageRef.current = setStatusMessage;
    submitRef.current = submit;
  }, [restoreValues, setStatusMessage, submit]);

  useEffect(() => {
    clearAutosaveTimer(timerRef);
    undoStackRef.current = [];
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
    if (!isDirty || isSubmitting) {
      return undefined;
    }

    timerRef.current = setTimeout(() => {
      setStatusMessageRef.current("autosaving changes");
      void submitRef.current();
    }, AUTOSAVE_DELAY_MS);

    return () => clearAutosaveTimer(timerRef);
  }, [isDirty, isSubmitting, serializedValues, values]);

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

  useEffect(() => () => clearAutosaveTimer(timerRef), []);

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
