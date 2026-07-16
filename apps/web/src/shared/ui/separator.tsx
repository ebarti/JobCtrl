import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ComponentRef,
} from "react";

import { cn } from "../lib/cn.js";

export const Separator = forwardRef<
  ComponentRef<typeof SeparatorPrimitive>,
  ComponentPropsWithoutRef<typeof SeparatorPrimitive>
>(({ className, orientation = "horizontal", ...props }, ref) => (
  <SeparatorPrimitive
    ref={ref}
    orientation={orientation}
    className={cn(
      "shrink-0 bg-border",
      orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]",
      className,
    )}
    {...props}
  />
));
Separator.displayName = SeparatorPrimitive.displayName ?? "Separator";
