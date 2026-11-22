import type { ReactNode } from "react";

import { OutcomeDraftRetentionProvider } from "./contexts/apply/index.js";

/** Explicit optional provider composition; feature packages never wrap core. */
export function FeatureProviders({ children }: { readonly children: ReactNode }) {
  return <OutcomeDraftRetentionProvider>{children}</OutcomeDraftRetentionProvider>;
}
