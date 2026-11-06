import { Button } from "../../../shared/ui/button.js";
import { useDeleteContactMutation } from "../hooks/useDeleteContactMutation.js";

export interface ContactDeleteButtonProps {
  contactId: string;
  expectedFingerprint?: string;
  displayName?: string;
  onDeleted?: () => void;
  label?: string;
  className?: string;
}

export function ContactDeleteButton({
  contactId,
  expectedFingerprint,
  displayName,
  onDeleted,
  label = "Delete",
  className,
}: ContactDeleteButtonProps) {
  const deleteContact = useDeleteContactMutation();

  const handleDelete = () => {
    if (!expectedFingerprint) return;
    const target = displayName ?? "this contact";
    if (!window.confirm(`Delete ${target}? This removes it from your outreach list.`)) {
      return;
    }
    deleteContact.mutate(
      { contactId, expectedFingerprint },
      { onSuccess: () => onDeleted?.() },
    );
  };

  return (
    <><Button
      type="button"
      {...(className ? { className } : {})}
      variant="destructive"
      disabled={!expectedFingerprint || deleteContact.isPending}
      onClick={handleDelete}
    >
      {deleteContact.isPending ? "Deleting…" : label}
    </Button>{deleteContact.error ? <span role="alert">{deleteContact.error.message}</span> : null}</>
  );
}
