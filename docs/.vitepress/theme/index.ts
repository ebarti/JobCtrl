import type { Theme } from "vitepress";
import { inBrowser } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { setupLightbox } from "./lightbox";
import "./custom.css";

// Extend the stock VitePress theme with a dependency-free click-to-expand
// lightbox for mermaid diagrams and content images. All DOM work is guarded by
// `inBrowser`; the setup itself installs a single document-level listener
// (see lightbox.ts) so it is safe to call once here even in the SPA.
export default {
  extends: DefaultTheme,
  enhanceApp() {
    if (inBrowser) {
      setupLightbox();
    }
  },
} satisfies Theme;
