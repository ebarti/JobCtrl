import { Button } from "../../../shared/ui/button.js";
import { useDeleteContactMutation } from "../hooks/useDeleteContactMutation.js";

export interface ContactDeleteButtonProps {
  contactId: string;
  displayName?: string;
  onDeleted?: () => void;
  label?: string;
  className?: string;
}

export function ContactDeleteButton({
  contactId,
  displayName,
  onDeleted,
  label = "Delete",
  className,
}: ContactDeleteButtonProps) {
  const deleteContact = useDeleteContactMutation();

  const handleDelete = () => {
    const target = displayName ?? "this contact";
    if (!window.confirm(`Delete ${target}? This removes it from your outreach list.`)) {
      return;
    }
    deleteContact.mutate(
      { contactId },
      { onSuccess: () => onDeleted?.() },
    );
  };

  return (
    <Button
      type="button"
      {...(className ? { className } : {})}
      variant="destructive"
      disabled={deleteContact.isPending}
      onClick={handleDelete}
    >
      {deleteContact.isPending ? "Deleting…" : label}
    </Button>
  );
}
