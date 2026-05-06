import * as LabelPrimitive from "@radix-ui/react-label";
import { Slot } from "@radix-ui/react-slot";
import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import { cn } from "../lib/cn.js";
import { Label } from "./label.js";

type FormFieldContextValue = { name: string };

const FormFieldContext = createContext<FormFieldContextValue | null>(null);

export function FormField({ name, children }: { name: string; children: ReactNode }) {
  return <FormFieldContext.Provider value={{ name }}>{children}</FormFieldContext.Provider>;
}

type FormItemContextValue = { id: string };

const FormItemContext = createContext<FormItemContextValue | null>(null);

export const FormItem = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const id = useId();
    return (
      <FormItemContext.Provider value={{ id }}>
        <div ref={ref} className={cn("space-y-2", className)} {...props} />
      </FormItemContext.Provider>
    );
  },
);
FormItem.displayName = "FormItem";

function useFormItem() {
  const item = useContext(FormItemContext);
  if (!item) {
    throw new Error("Form item primitives must be used inside <FormItem>.");
  }
  const field = useContext(FormFieldContext);
  if (!field) {
    throw new Error("Form item primitives must be used inside <FormField>.");
  }
  return {
    id: item.id,
    name: field.name,
    formItemId: `${item.id}-form-item`,
    formDescriptionId: `${item.id}-form-item-description`,
    formMessageId: `${item.id}-form-item-message`,
  };
}

export const FormLabel = forwardRef<
  ComponentRef<typeof LabelPrimitive.Root>,
  ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => {
  const { formItemId } = useFormItem();
  return <Label ref={ref} className={cn(className)} htmlFor={formItemId} {...props} />;
});
FormLabel.displayName = "FormLabel";

export const FormControl = forwardRef<
  ComponentRef<typeof Slot>,
  ComponentPropsWithoutRef<typeof Slot>
>(({ ...props }, ref) => {
  const { formItemId, formDescriptionId, formMessageId } = useFormItem();
  return (
    <Slot
      ref={ref}
      id={formItemId}
      aria-describedby={`${formDescriptionId} ${formMessageId}`}
      {...props}
    />
  );
});
FormControl.displayName = "FormControl";

export const FormDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => {
    const { formDescriptionId } = useFormItem();
    return (
      <p ref={ref} id={formDescriptionId} className={cn("text-sm text-muted", className)} {...props} />
    );
  },
);
FormDescription.displayName = "FormDescription";

export const FormMessage = forwardRef<
  HTMLParagraphElement,
  HTMLAttributes<HTMLParagraphElement>
>(({ className, children, ...props }, ref) => {
  const { formMessageId } = useFormItem();
  if (!children) {
    return null;
  }
  return (
    <p ref={ref} id={formMessageId} className={cn("text-sm font-medium text-danger", className)} {...props}>
      {children}
    </p>
  );
});
FormMessage.displayName = "FormMessage";
