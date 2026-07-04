import type { Theme } from "vitepress";
import { inBrowser } from "vitepress";
import DefaultTheme from "vitepress/theme";
import MermaidRenderer from "./MermaidRenderer.vue";
import { setupAriaCurrent } from "./aria-current";
import { setupLightbox } from "./lightbox";
import "./custom.css";

// Extend the stock VitePress theme with a dependency-free click-to-expand
// lightbox for mermaid diagrams and content images, and take over mermaid
// rendering: registering "Mermaid" here runs AFTER vitepress-plugin-mermaid's
// spliced-in registration, so this component wins and both color modes get
// the curated palettes in mermaid-theme.ts (the stock component forces
// mermaid's stock dark theme in dark mode). All DOM work is guarded by
// `inBrowser`; the lightbox installs a single document-level listener (see
// lightbox.ts) so it is safe to call once here even in the SPA.
export default {
  extends: DefaultTheme,
  enhanceApp({ app, router }) {
    app.component("Mermaid", MermaidRenderer);
    if (inBrowser) {
      setupLightbox();
      setupAriaCurrent(router);
    }
  },
} satisfies Theme;
