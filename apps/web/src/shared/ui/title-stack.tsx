import type { JSX, ReactNode } from "react";

export interface TitleStackProps {
  primary: ReactNode;
  secondary?: ReactNode;
}

export function TitleStack({ primary, secondary }: TitleStackProps): JSX.Element {
  return (
    <span className="title-stack">
      <b>{primary}</b>
      {secondary ? <span>{secondary}</span> : null}
    </span>
  );
}
