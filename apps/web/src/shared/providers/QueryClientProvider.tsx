import { type QueryClient, QueryClientProvider as TanStackQueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";

export interface QueryClientProviderProps {
  client: QueryClient;
  children: ReactNode;
}

export function QueryClientProvider({ client, children }: QueryClientProviderProps) {
  return <TanStackQueryClientProvider client={client}>{children}</TanStackQueryClientProvider>;
}
