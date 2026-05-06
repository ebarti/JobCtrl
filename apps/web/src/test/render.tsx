import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, renderHook, type RenderHookOptions, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { EventStreamProvider } from "../contexts/operations/providers/EventStreamProvider.js";
import { DensityProvider } from "../shared/providers/DensityProvider.js";
import { PortsProvider, type Ports } from "../shared/providers/PortsProvider.js";
import { TenantProvider } from "../shared/providers/TenantProvider.js";
import { ThemeProvider } from "../shared/providers/ThemeProvider.js";
import { ToasterProvider } from "../shared/providers/ToasterProvider.js";
import { TooltipProvider } from "../shared/ui/tooltip.js";
import { buildTestPorts } from "./testPorts.js";

export interface RenderWithProvidersOptions extends Omit<RenderOptions, "wrapper"> {
  readonly ports?: Ports;
  readonly queryClient?: QueryClient;
  readonly withEventStream?: boolean;
  readonly withRouter?: boolean;
  readonly initialEntries?: readonly string[];
}

export function createTestQueryClient(): QueryClient {
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

export interface ProviderHarness {
  readonly ports: Ports;
  readonly queryClient: QueryClient;
  readonly Wrapper: ({ children }: { children: ReactNode }) => ReactElement;
}

export function buildProviderHarness(opts: RenderWithProvidersOptions = {}): ProviderHarness {
  const ports = opts.ports ?? buildTestPorts();
  const queryClient = opts.queryClient ?? createTestQueryClient();
  const useEvents = opts.withEventStream ?? false;
  const useRouter = opts.withRouter ?? false;

  function CoreProviders({ children }: { children: ReactNode }): ReactElement {
    return (
      <PortsProvider ports={ports}>
        <TenantProvider>
          <QueryClientProvider client={queryClient}>
            <ThemeProvider>
              <DensityProvider>
                <TooltipProvider>
                  <ToasterProvider>
                    {useEvents ? <EventStreamProvider>{children}</EventStreamProvider> : children}
                  </ToasterProvider>
                </TooltipProvider>
              </DensityProvider>
            </ThemeProvider>
          </QueryClientProvider>
        </TenantProvider>
      </PortsProvider>
    );
  }

  function Wrapper({ children }: { children: ReactNode }): ReactElement {
    if (!useRouter) {
      return <CoreProviders>{children}</CoreProviders>;
    }
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <>{children}</>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: [...(opts.initialEntries ?? ["/"])] }),
    });
    return (
      <CoreProviders>
        <RouterProvider router={router} />
      </CoreProviders>
    );
  }

  return { ports, queryClient, Wrapper };
}

export function renderWithProviders(ui: ReactElement, opts: RenderWithProvidersOptions = {}) {
  const harness = buildProviderHarness(opts);
  const utils = render(ui, { ...opts, wrapper: harness.Wrapper });
  return { ...utils, ports: harness.ports, queryClient: harness.queryClient };
}

export interface RenderHookWithProvidersOptions<TProps> extends RenderWithProvidersOptions {
  readonly initialProps?: TProps;
}

export function renderHookWithProviders<TResult, TProps>(
  callback: (props: TProps) => TResult,
  opts: RenderHookWithProvidersOptions<TProps> = {},
) {
  const harness = buildProviderHarness(opts);
  const renderHookOpts: RenderHookOptions<TProps> = {
    wrapper: harness.Wrapper,
  };
  if ("initialProps" in opts && opts.initialProps !== undefined) {
    (renderHookOpts as { initialProps?: TProps }).initialProps = opts.initialProps;
  }
  const utils = renderHook(callback, renderHookOpts);
  return { ...utils, ports: harness.ports, queryClient: harness.queryClient };
}
