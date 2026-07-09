import type { Theme } from "vitepress";
import { inBrowser } from "vitepress";
import DefaultTheme from "vitepress/theme";
import MermaidRenderer from "./MermaidRenderer.vue";
import WorkflowSurfacePanel from "./WorkflowSurfacePanel.vue";
import WorkflowSurfaceSelector from "./WorkflowSurfaceSelector.vue";
import { setupAriaCurrent } from "./aria-current";
import { setupChannelSelector } from "./channel-selector";
import { setupLightbox } from "./lightbox";
import { setupSearchA11y } from "./search-a11y";
import "./custom.css";

// Extend the stock VitePress theme with JobCtrl docs components, a
// dependency-free click-to-expand lightbox, and curated Mermaid rendering.
// Registering "Mermaid" here runs AFTER vitepress-plugin-mermaid's spliced-in
// registration, so this component wins and both color modes get the palettes
// in mermaid-theme.ts. All DOM work is guarded by `inBrowser`; the lightbox
// installs a single document-level listener (see lightbox.ts), so it is safe
// to call once here even in the SPA.
export default {
  extends: DefaultTheme,
  enhanceApp({ app, router }) {
    app.component("Mermaid", MermaidRenderer);
    app.component("WorkflowSurfacePanel", WorkflowSurfacePanel);
    app.component("WorkflowSurfaceSelector", WorkflowSurfaceSelector);
    if (inBrowser) {
      setupLightbox();
      setupAriaCurrent(router);
      setupChannelSelector(router);
      setupSearchA11y();
    }
  },
} satisfies Theme;
