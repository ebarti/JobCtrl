import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn.js";

export interface InspectorLedgerProps
  extends HTMLAttributes<HTMLDListElement> {
  readonly children: ReactNode;
}

export function InspectorLedger({
  children,
  className,
  ...props
}: InspectorLedgerProps) {
  return (
    <dl className={cn("inspector-ledger", className)} {...props}>
      {children}
    </dl>
  );
}

export interface InspectorLedgerItemProps
  extends HTMLAttributes<HTMLDivElement> {
  readonly label: ReactNode;
  readonly value?: ReactNode;
  readonly source?: ReactNode;
  readonly status?: ReactNode;
}

export function InspectorLedgerItem({
  label,
  value,
  source,
  status,
  className,
  ...props
}: InspectorLedgerItemProps) {
  return (
    <div className={cn("inspector-ledger__item", className)} {...props}>
      <dt data-typography="label">{label}</dt>
      <dd data-typography="body">
        {value ?? (
          <span className="inspector-ledger__missing">Not available</span>
        )}
        {source ? (
          <span className="inspector-ledger__source" data-typography="metadata">
            {source}
          </span>
        ) : null}
        {status ? (
          <span className="inspector-ledger__status" data-typography="metadata">
            {status}
          </span>
        ) : null}
      </dd>
    </div>
  );
}
