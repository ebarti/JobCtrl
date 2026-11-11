import { createContext, useContext, type JSX, type ReactNode } from "react";

import { cn } from "../lib/cn.js";

export interface PageHeadProps {
  title: string;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

const PageHeadNavigationContext = createContext<ReactNode>(null);

/** The application shell supplies one contextual navigation slot after the page heading. */
export function PageHeadNavigationProvider({ children, navigation }: { readonly children: ReactNode; readonly navigation: ReactNode }) {
  return <PageHeadNavigationContext.Provider value={navigation}>{children}</PageHeadNavigationContext.Provider>;
}

export function PageHead({
  title,
  eyebrow,
  subtitle,
  actions,
  className,
}: PageHeadProps): JSX.Element {
  const navigation = useContext(PageHeadNavigationContext);
  const showEyebrow = eyebrow && !(typeof eyebrow === "string" && eyebrow.trim().toLocaleLowerCase() === title.trim().toLocaleLowerCase());
  return (
    <>
    <header className={cn("page-head", className)} data-slot="page-head">
      <div className="page-head-text" data-slot="page-head-text">
        {showEyebrow ? <p className="page-head-section" data-slot="page-head-eyebrow" data-typography="metadata">{eyebrow}</p> : null}
        <h1 data-slot="page-head-title" data-typography="page-title">
          {title}
        </h1>
        {subtitle ? (
          <p
            className="page-head-subtitle"
            data-slot="page-head-subtitle"
            data-typography="metadata"
          >
            {subtitle}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="page-head-actions" data-slot="page-head-actions">
          {actions}
        </div>
      ) : null}
    </header>
    {navigation}
    </>
  );
}
