import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef } from "react";

import { cn } from "../lib/cn.js";

const buttonVariants = cva(
  "jh-control jh-button inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[0_1px_2px_rgb(0_0_0_/_0.14)] hover:bg-primary/90 active:translate-y-px",
        success:
          "bg-success text-success-foreground shadow-[0_1px_2px_rgb(0_0_0_/_0.14)] hover:bg-success/90 focus-visible:ring-success active:translate-y-px",
        warning:
          "bg-warning text-warning-foreground shadow-[0_1px_2px_rgb(0_0_0_/_0.1)] hover:bg-warning/90 focus-visible:ring-warning active:translate-y-px",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive disabled:bg-destructive/60 disabled:text-white disabled:opacity-100 active:translate-y-px",
        outline: "border-border bg-card text-foreground hover:bg-muted",
        secondary: "bg-secondary text-secondary-foreground hover:bg-accent",
        ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "jh-control-default h-9 px-3.5",
        sm: "jh-control-sm h-8 px-3 text-sm",
        lg: "jh-control-lg h-10 px-4",
        icon: "jh-control-icon size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends
    Omit<ButtonPrimitive.Props, "className">,
    VariantProps<typeof buttonVariants> {
  className?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <ButtonPrimitive
      data-size={size ?? "default"}
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export { buttonVariants };
