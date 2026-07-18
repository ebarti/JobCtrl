import { useId } from "react";

import { Button } from "../../../shared/ui/button.js";
import { Field, FieldLabel } from "../../../shared/ui/field.js";
import { Textarea } from "../../../shared/ui/textarea.js";

export interface EditorProps {
  dirty: boolean;
  label: string;
  saving: boolean;
  value: string;
  onChange: (value: string) => void;
  onDiscard: () => void;
  onSave: () => void;
}

export function Editor({
  dirty,
  label,
  saving,
  value,
  onChange,
  onDiscard,
  onSave,
}: EditorProps) {
  const editorId = useId();

  return (
    <Field className={`editor ${dirty ? "dirty" : ""}`}>
      <div>
        <FieldLabel htmlFor={editorId}>{label}</FieldLabel>
        {dirty ? (
          <span className="field-actions-inline">
            <Button
              type="button"
              disabled={saving}
              size="sm"
              onClick={(event) => {
                event.preventDefault();
                onSave();
              }}
            >
              {saving ? "Saving" : "Save"}
            </Button>
            <Button
              type="button"
              disabled={saving}
              size="sm"
              variant="outline"
              onClick={(event) => {
                event.preventDefault();
                onDiscard();
              }}
            >
              Discard
            </Button>
          </span>
        ) : null}
      </div>
      <Textarea id={editorId} value={value} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}
