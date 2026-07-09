import "../src/styles/globals.css";

import { QueryClient } from "@tanstack/react-query";
import type { Decorator, Preview } from "@storybook/react-vite";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { initialize, mswLoader } from "msw-storybook-addon";
import { useEffect, useMemo, type ReactElement, type ReactNode } from "react";

import { handlers } from "../src/test/msw/handlers.js";
import { buildStoryPorts } from "./storyPorts.js";
import { EventStreamProvider } from "../src/contexts/operations/providers/EventStreamProvider.js";
import { DensityProvider } from "../src/shared/providers/DensityProvider.js";
import { PortsProvider } from "../src/shared/providers/PortsProvider.js";
import { QueryClientProvider } from "../src/shared/providers/QueryClientProvider.js";
import { TenantProvider } from "../src/shared/providers/TenantProvider.js";
import { ThemeProvider } from "../src/shared/providers/ThemeProvider.js";
import { ToasterProvider } from "../src/shared/providers/ToasterProvider.js";
import { TooltipProvider } from "../src/shared/ui/tooltip.js";
import { useUiPreferencesStore } from "../src/shared/stores/ui-preferences.js";

initialize({
  onUnhandledRequest: "bypass",
});

function makeStoryQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        staleTime: 0,
        refetchOnMount: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

function ThemeBridge({ theme, children }: { theme: "light" | "dark"; children: ReactNode }): ReactElement {
  const setTheme = useUiPreferencesStore((state) => state.setTheme);
  useEffect(() => {
    setTheme(theme);
  }, [theme, setTheme]);
  return <>{children}</>;
}

function makeStubRouter(initialPath: string, story: ReactElement) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const wildcardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => story,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([wildcardRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

const withProviders: Decorator = (Story, context) => {
  const ports = useMemo(() => buildStoryPorts(), []);
  const queryClient = useMemo(() => makeStoryQueryClient(), [context.id]);
  const theme = (context.globals["theme"] as "light" | "dark" | undefined) ?? "light";
  const withEventStream = (context.parameters["withEventStream"] as boolean | undefined) ?? false;
  const withRouter = (context.parameters["withRouter"] as boolean | undefined) ?? false;
  const initialPath = (context.parameters["initialPath"] as string | undefined) ?? "/";

  const storyElement = <Story />;
  const eventStreamWrapped = withEventStream ? (
    <EventStreamProvider>{storyElement}</EventStreamProvider>
  ) : (
    storyElement
  );
  const router = useMemo(
    () => (withRouter ? makeStubRouter(initialPath, eventStreamWrapped) : null),
    // Routers are recreated when story / withRouter / path change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [context.id, withRouter, initialPath],
  );
  const inner = router ? <RouterProvider router={router} /> : eventStreamWrapped;

  return (
    <PortsProvider ports={ports}>
      <TenantProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeBridge theme={theme}>
            <ThemeProvider>
              <DensityProvider>
                <TooltipProvider>
                  <ToasterProvider>
                    <div className="min-h-[80vh] bg-background p-6 text-foreground">{inner}</div>
                  </ToasterProvider>
                </TooltipProvider>
              </DensityProvider>
            </ThemeProvider>
          </ThemeBridge>
        </QueryClientProvider>
      </TenantProvider>
    </PortsProvider>
  );
};

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    msw: {
      handlers,
    },
    a11y: {
      // Storybook 9+ a11y addon: "error" turns critical/serious axe
      // violations into a red badge on the toolbar AND fails CI when
      // run via `storybook test` or the addon-vitest integration.
      // Per docs/architecture/frontend/testing.md §10.7, the bar is "no
      // critical or serious violations" for input-bearing surfaces.
      test: "error",
      config: {
        rules: [
          // Color-contrast checks are run via the addon panel; we keep
          // them informational rather than CI-blocking because tokens
          // shift across light/dark themes and would otherwise force
          // story-by-story overrides.
          { id: "color-contrast", reviewOnFail: true },
        ],
      },
    },
    backgrounds: {
      default: "light",
      values: [
        { name: "light", value: "#fafafa" },
        { name: "dark", value: "#0b0b0d" },
      ],
    },
    layout: "padded",
  },
  globalTypes: {
    theme: {
      description: "Application theme",
      defaultValue: "light",
      toolbar: {
        title: "Theme",
        icon: "circlehollow",
        items: [
          { value: "light", title: "Light", icon: "sun" },
          { value: "dark", title: "Dark", icon: "moon" },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [withProviders],
  loaders: [mswLoader],
  tags: ["autodocs"],
};

export default preview;
