import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { IconCheck } from "@tabler/icons-react";
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from "react";

import { cn } from "../lib/cn.js";

export const Checkbox = forwardRef<
  ComponentRef<typeof CheckboxPrimitive.Root>,
  ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer grid size-[18px] shrink-0 place-items-center rounded-[4px] border border-input bg-card text-primary-foreground shadow-[0_1px_1px_rgb(15_23_42/0.04)] transition-[border-color,background-color,box-shadow] hover:border-foreground/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-55 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className={cn("flex items-center justify-center text-current")}>
      <IconCheck className="size-[14px]" stroke={2.7} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;
