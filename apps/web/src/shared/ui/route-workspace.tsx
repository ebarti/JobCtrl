import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn.js";

export interface RouteWorkspaceProps extends HTMLAttributes<HTMLElement> {
  readonly header?: ReactNode;
  readonly navigation?: ReactNode;
  readonly inspector?: ReactNode;
  readonly children: ReactNode;
  readonly contentLabel?: string;
  readonly navigationLabel?: string;
  readonly inspectorLabel?: string;
}

/**
 * Document-level layout for detail URLs. Unlike a dialog or sheet, this
 * component stays in normal document flow and leaves navigation to the route.
 */
export function RouteWorkspace({
  header,
  navigation,
  inspector,
  children,
  contentLabel = "Detail workspace",
  navigationLabel = "Workspace navigation",
  inspectorLabel = "Details and provenance",
  className,
  ...props
}: RouteWorkspaceProps) {
  return (
    <article className={cn("route-workspace", className)} {...props}>
      {header ? (
        <header className="route-workspace__header">{header}</header>
      ) : null}
      <div
        className="route-workspace__grid"
        data-has-inspector={Boolean(inspector)}
        data-has-navigation={Boolean(navigation)}
      >
        {navigation ? (
          <aside
            className="route-workspace__navigation"
            aria-label={navigationLabel}
          >
            {navigation}
          </aside>
        ) : null}
        <section className="route-workspace__content" aria-label={contentLabel}>
          {children}
        </section>
        {inspector ? (
          <aside
            className="route-workspace__inspector"
            aria-label={inspectorLabel}
          >
            {inspector}
          </aside>
        ) : null}
      </div>
    </article>
  );
}
