import { z } from "zod";

/** Provenance returned by the Python model gateway for a persisted attempt. */
export const ModelReceiptSchema = z
  .object({
    receipt_id: z.string().uuid(),
    provider: z.string().min(1),
    model: z.string().min(1),
    lane: z.string().min(1),
    prompt_version: z.string().min(1),
    input_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    created_at: z.string().min(1),
  })
  .passthrough();
