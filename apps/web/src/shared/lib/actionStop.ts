import { z } from "zod";

export const cancellationDeliverySchema = z.enum(["pending", "acknowledged"]).nullish();

export function canRequestStop(run: {
  cancellationRequested: boolean;
  cancellationDelivery?: z.infer<typeof cancellationDeliverySchema>;
} | null | undefined): boolean {
  return Boolean(run && (!run.cancellationRequested || run.cancellationDelivery === "pending"));
}
