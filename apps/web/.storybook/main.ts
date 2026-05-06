import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y", "msw-storybook-addon"],
  // public/mockServiceWorker.js (committed; regenerated via `pnpm exec msw init
  // public/ --save`) must ship next to iframe.html so the msw-storybook-addon
  // can register the worker at story load. Without it the addon hangs and
  // every test-storybook smoke test times out at 15 s.
  staticDirs: ["../public"],
  typescript: {
    reactDocgen: "react-docgen-typescript",
    check: false,
  },
  viteFinal: async (viteConfig) => {
    // The TanStack Router Vite plugin scans `src/routes/**` and emits a
    // generated route tree at runtime. Storybook never mounts the router,
    // so dropping the plugin keeps the Storybook bundle from regenerating
    // `routeTree.gen.ts` on every edit and from importing route files
    // that are unrelated to component stories.
    if (viteConfig.plugins) {
      viteConfig.plugins = viteConfig.plugins.filter((plugin) => {
        if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) return true;
        const name = (plugin as { name?: string }).name ?? "";
        return !name.startsWith("tanstack-router");
      });
    }
    return viteConfig;
  },
  // Visual regression (Chromatic, Loki) is named in docs/frontend-target.md
  // §10.5 / §9 as the next evolution but is intentionally not wired here.
  // Both are a one-line CI hook over a `storybook build` artefact when the
  // user wants to opt in.
};

export default config;
