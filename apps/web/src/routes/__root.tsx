import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import type { RouterContext } from "../router.js";
import { AppShell } from "../shared/layout/AppShell.js";
import { Empty } from "../shared/ui/empty.js";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootComponent() {
  const showDevtools =
    import.meta.env.DEV && import.meta.env.VITE_JOBCTL_HIDE_DEVTOOLS !== "1";

  return (
    <>
      <AppShell />
      {showDevtools ? (
        <>
          <TanStackRouterDevtools position="bottom-right" />
          <ReactQueryDevtools buttonPosition="bottom-left" />
        </>
      ) : null}
    </>
  );
}

function NotFoundComponent() {
  return <Empty title="Page not found." />;
}
