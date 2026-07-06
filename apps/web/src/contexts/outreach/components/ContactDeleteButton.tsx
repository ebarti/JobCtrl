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
  label = "delete",
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
    <button
      type="button"
      className={className ?? "tab"}
      disabled={deleteContact.isPending}
      onClick={handleDelete}
    >
      {deleteContact.isPending ? "deleting" : label}
    </button>
  );
}
