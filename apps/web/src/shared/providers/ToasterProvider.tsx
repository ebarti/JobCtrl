import type { ReactNode } from "react";

import { Toaster } from "../ui/toaster.js";

export function ToasterProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Toaster />
    </>
  );
}
