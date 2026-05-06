import type { ReactNode } from "react";

// Pass-through. The density attribute is rendered on the AppShell root
// (target §4.10, plan S-05/S-06), not on <html>, to keep portaled overlays
// out of its inheritance scope. The provider survives for tree symmetry
// and as a stable seam if a future cross-cutting density hook needs context.
export function DensityProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
