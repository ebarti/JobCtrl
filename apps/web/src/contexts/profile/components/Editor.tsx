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
  return (
    <label className={`editor ${dirty ? "dirty" : ""}`}>
      <span>
        {label}
        {dirty ? (
          <span className="field-actions-inline">
            <button
              className="tab on"
              type="button"
              disabled={saving}
              onClick={(event) => {
                event.preventDefault();
                onSave();
              }}
            >
              {saving ? "saving" : "save"}
            </button>
            <button
              className="tab"
              type="button"
              disabled={saving}
              onClick={(event) => {
                event.preventDefault();
                onDiscard();
              }}
            >
              discard
            </button>
          </span>
        ) : null}
      </span>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
