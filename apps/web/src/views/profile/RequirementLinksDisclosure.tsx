import type { ReactNode } from "react";

/** Matching metadata stays available without competing with authored wording. */
export function RequirementLinksDisclosure({
  links,
  onSelectRequirement,
  label = "Linked requirements",
  children,
}: {
  readonly links: readonly { id: string; definition: string; status: string }[];
  readonly onSelectRequirement: (requirementId: string) => void;
  readonly label?: string;
  readonly children?: ReactNode;
}) {
  return (
    <details className="achievement-requirements__disclosure">
      <summary>{label} <span>({links.length})</span></summary>
      <div className="achievement-requirements__content">
        <ul className="achievement-requirements__list">
          {links.map((link) => (
            <li key={link.id}>
              <button type="button" data-typography="body" onClick={() => onSelectRequirement(link.id)}>
                <span>{link.definition}</span>
                <small>{link.status}</small>
              </button>
            </li>
          ))}
        </ul>
        {children}
      </div>
    </details>
  );
}
