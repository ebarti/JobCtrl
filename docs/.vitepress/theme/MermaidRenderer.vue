<template>
  <div v-html="svg" :class="props.class"></div>
</template>

<script setup lang="ts">
// Replaces vitepress-plugin-mermaid's stock component (registered later in
// enhanceApp, so this one wins). The plugin still owns the markdown transform
// that emits <Mermaid id graph> — the props contract here must match it.
// Owning the renderer lets both color modes use curated "base"-theme palettes
// (mermaid-theme.ts) instead of the plugin's forced stock dark theme.
import { onMounted, onUnmounted, ref } from "vue";
import { MERMAID_DARK, MERMAID_LIGHT } from "./mermaid-theme";

const props = defineProps({
  graph: { type: String, required: true },
  id: { type: String, required: true },
  class: { type: String, required: false, default: "mermaid" },
});

const svg = ref("");
let observer: MutationObserver | null = null;
let renderToken = 0;

async function renderChart() {
  const token = ++renderToken;
  const { default: mermaid } = await import("mermaid");
  const dark = document.documentElement.classList.contains("dark");
  // initialize() fully resets config each call, so palette switches are clean.
  mermaid.initialize(structuredClone(dark ? MERMAID_DARK : MERMAID_LIGHT));
  const code = decodeURIComponent(props.graph);
  const { svg: svgCode } = await mermaid.render(props.id, code);
  if (token !== renderToken) return; // a newer render superseded this one
  // Salt forces v-html to re-apply when mermaid re-renders into an identical
  // string after a theme toggle removed the node out of Vue's sight.
  const salt = Math.random().toString(36).slice(2, 9);
  svg.value = `${svgCode}<span style="display:none">${salt}</span>`;
}

onMounted(async () => {
  // Re-render when the html element's attributes change (the appearance
  // toggle flips the `dark` class) — same trigger the stock component uses.
  observer = new MutationObserver(() => void renderChart());
  observer.observe(document.documentElement, { attributes: true });
  await renderChart();
});

onUnmounted(() => observer?.disconnect());
</script>
