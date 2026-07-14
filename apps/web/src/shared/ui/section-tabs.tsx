import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/cn.js";
import { Tabs, TabsList } from "./tabs.js";

export function SectionTabs({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof Tabs>) {
  return <Tabs className={cn("section-tabs", className)} {...props} />;
}

export function SectionTabsList({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof TabsList>) {
  return <TabsList className={cn("section-tabs__list", className)} {...props} />;
}
