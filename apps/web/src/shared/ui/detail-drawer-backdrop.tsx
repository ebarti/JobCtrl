import type { ReactNode } from "react";

import { cn } from "../lib/cn.js";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./sheet.js";

export interface DetailDrawerProps {
  children: ReactNode;
  className?: string;
  description: string;
  onDismiss: () => void;
  title: string;
}

export function DetailDrawer({
  children,
  className,
  description,
  onDismiss,
  title,
}: DetailDrawerProps) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <SheetContent
        className={cn("drawer detail-drawer", className)}
        data-slot="detail-drawer"
        side="right"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}
