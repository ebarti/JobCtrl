import type { JSX, ReactNode } from "react";

export interface TitleStackProps {
  primary: ReactNode;
  secondary?: ReactNode;
}

export function TitleStack({ primary, secondary }: TitleStackProps): JSX.Element {
  return (
    <span className="title-stack" data-slot="title-stack">
      <b data-slot="title-stack-primary">{primary}</b>
      {secondary ? (
        <span data-slot="title-stack-secondary">{secondary}</span>
      ) : null}
    </span>
  );
}
