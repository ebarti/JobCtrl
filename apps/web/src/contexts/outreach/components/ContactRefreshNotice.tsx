import { Button } from "../../../shared/ui/button.js";

export function ContactRefreshNotice({ retry, detail = false, initial = false }: { retry: () => void; detail?: boolean; initial?: boolean }) {
  return (
    <div className="banner inline" role="status">
      <span>{initial
        ? (detail ? "Contact details could not be loaded." : "Contacts could not be loaded.")
        : (detail ? "Contact details could not be refreshed. The details shown may be out of date." : "Contacts could not be refreshed. The list shown may be out of date.")}</span>{" "}
      <Button type="button" size="sm" variant="outline" onClick={retry}>Retry refresh</Button>
    </div>
  );
}
