<template>
  <div
    ref="container"
    v-html="svg"
    :class="props.class"
    :data-jh-diagram-layout="diagramLayout"
  ></div>
</template>

<script setup lang="ts">
// Replaces vitepress-plugin-mermaid's stock component (registered later in
// enhanceApp, so this one wins). The plugin still owns the markdown transform
// that emits <Mermaid id graph> — the props contract here must match it.
// Owning the renderer lets both color modes use curated "base"-theme palettes
// (mermaid-theme.ts) instead of the plugin's forced stock dark theme.
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { MERMAID_DARK, MERMAID_LIGHT } from "./mermaid-theme";

type MermaidApi = (typeof import("mermaid"))["default"];

const props = defineProps({
  graph: { type: String, required: true },
  id: { type: String, required: true },
  class: { type: String, required: false, default: "mermaid" },
});

const svg = ref("");
const container = ref<HTMLElement | null>(null);
const diagramLayout = ref<"balanced" | "scroll">("balanced");
let observer: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let renderToken = 0;
let iconPacksRegistered = false;

const MIN_LABEL_HEIGHT = 12;
const MAX_SCROLL_WIDTH = 1440;

function registerIconPacks(mermaid: MermaidApi): void {
  if (iconPacksRegistered) return;
  mermaid.registerIconPacks([
    {
      name: "tabler",
      loader: () => import("@iconify-json/tabler").then((module) => module.icons),
    },
  ]);
  iconPacksRegistered = true;
}

function svgSize(svgElement: SVGSVGElement): { width: number; height: number } | null {
  const values = (svgElement.getAttribute("viewBox") ?? "")
    .trim()
    .split(/\s+/)
    .map(Number);
  if (values.length !== 4 || !values.every(Number.isFinite)) return null;
  const [, , width, height] = values;
  return width > 0 && height > 0 ? { width, height } : null;
}

function medianLabelHeight(svgElement: SVGSVGElement): number | null {
  const heights = Array.from(
    svgElement.querySelectorAll<SVGGraphicsElement>(
      ".nodeLabel, .edgeLabel, .messageText, .labelText, text",
    ),
  )
    .map((label) => label.getBoundingClientRect().height)
    .filter((height) => height > 0)
    .sort((left, right) => left - right);
  return heights.length > 0 ? heights[Math.floor(heights.length / 2)] : null;
}

function applyDiagramSizing(): void {
  const host = container.value;
  const svgElement = host?.querySelector<SVGSVGElement>("svg");
  if (!host || !svgElement) return;

  const size = svgSize(svgElement);
  if (!size) return;

  const availableWidth = Math.max(1, host.clientWidth - 16);
  const initialWidth = Math.min(size.width, availableWidth);
  host.style.setProperty("--jh-mermaid-render-width", `${Math.round(initialWidth)}px`);

  const labelHeight = medianLabelHeight(svgElement);
  const needsReadableScroll =
    labelHeight !== null && labelHeight < MIN_LABEL_HEIGHT && size.width > availableWidth;
  if (!needsReadableScroll) {
    diagramLayout.value = "balanced";
    return;
  }

  const readabilityScale = MIN_LABEL_HEIGHT / labelHeight;
  const readableWidth = Math.min(
    MAX_SCROLL_WIDTH,
    Math.ceil(initialWidth * readabilityScale),
  );
  host.style.setProperty("--jh-mermaid-render-width", `${readableWidth}px`);
  diagramLayout.value = readableWidth > availableWidth + 1 ? "scroll" : "balanced";
}

async function renderChart() {
  const token = ++renderToken;
  try {
    const { default: mermaid } = await import("mermaid");
    registerIconPacks(mermaid);
    const dark = document.documentElement.classList.contains("dark");
    // initialize() fully resets config each call, so palette switches are clean.
    mermaid.initialize(structuredClone(dark ? MERMAID_DARK : MERMAID_LIGHT));
    const code = decodeURIComponent(props.graph);
    const rendered = await mermaid.render(props.id, code);
    if (token !== renderToken) return; // a newer render superseded this one
    // Salt forces v-html to re-apply when mermaid re-renders into an identical
    // string after a theme toggle removed the node out of Vue's sight.
    const salt = Math.random().toString(36).slice(2, 9);
    svg.value = `${rendered.svg}<span style="display:none">${salt}</span>`;
    await nextTick();
    applyDiagramSizing();
  } catch (error) {
    console.error("JobCtrl docs Mermaid render failed", error);
  }
}

onMounted(async () => {
  // Re-render when the html element's attributes change (the appearance
  // toggle flips the `dark` class) — same trigger the stock component uses.
  observer = new MutationObserver(() => void renderChart());
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  resizeObserver = new ResizeObserver(() => applyDiagramSizing());
  if (container.value) resizeObserver.observe(container.value);
  await renderChart();
});

onUnmounted(() => {
  observer?.disconnect();
  resizeObserver?.disconnect();
});
</script>
