import type { JSX, ReactNode } from "react";

import { cn } from "../lib/cn.js";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./breadcrumb.js";

export interface PageHeadProps {
  title: string;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHead({
  title,
  eyebrow,
  subtitle,
  actions,
  className,
}: PageHeadProps): JSX.Element {
  return (
    <header className={cn("page-head", className)} data-slot="page-head">
      <div className="page-head-text" data-slot="page-head-text">
        <h1 data-slot="page-head-title" data-typography="page-title">
          {title}
        </h1>
        <Breadcrumb>
          <BreadcrumbList data-typography="metadata">
            {eyebrow ? (
              <>
                <BreadcrumbItem>
                  <span
                    className="page-head-section"
                    data-slot="page-head-eyebrow"
                    data-typography="metadata"
                  >
                    {eyebrow}
                  </span>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
              </>
            ) : null}
            <BreadcrumbItem>
              <BreadcrumbPage
                aria-disabled={undefined}
                data-typography="metadata"
                role={undefined}
              >
                {title}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
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
  );
}
