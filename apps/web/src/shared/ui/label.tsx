import { cva, type VariantProps } from "class-variance-authority";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ComponentRef,
} from "react";

import { cn } from "../lib/cn.js";

const labelVariants = cva(
  "text-[12px] font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
);

export const Label = forwardRef<
  ComponentRef<"label">,
  ComponentPropsWithoutRef<"label"> & VariantProps<typeof labelVariants>
>(({ className, ...props }, ref) => (
  <label ref={ref} className={cn(labelVariants(), className)} {...props} />
));
Label.displayName = "Label";
