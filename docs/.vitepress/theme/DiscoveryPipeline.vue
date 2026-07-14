<script setup lang="ts">
import type { Component } from "vue";
import {
  IconAdjustmentsCheck,
  IconArrowDown,
  IconChartBar,
  IconDatabase,
  IconDeviceDesktop,
  IconListSearch,
  IconTargetArrow,
  IconWorldSearch,
} from "@tabler/icons-vue";

interface DiscoveryStage {
  description: string;
  detail?: readonly string[];
  icon: Component;
  number: string;
  scope: string;
  title: string;
  tone: "intent" | "network" | "process" | "gate" | "stored" | "next";
}

const stages: readonly DiscoveryStage[] = [
  {
    description: "Roles, locations, work models, tracks, and seniority floors define what JobCtrl should look for.",
    icon: IconTargetArrow,
    number: "01",
    scope: "Local intent",
    title: "Compile target intent",
    tone: "intent",
  },
  {
    description: "Broad boards receive compiled queries; configured ATS and Workday sources enumerate their postings.",
    detail: ["Board search", "ATS", "Workday"],
    icon: IconWorldSearch,
    number: "02",
    scope: "Network sources",
    title: "Query or enumerate sources",
    tone: "network",
  },
  {
    description: "Returned listings are extracted and mapped into one consistent posting shape for the same checks.",
    icon: IconListSearch,
    number: "03",
    scope: "JobCtrl processing",
    title: "Extract and normalize",
    tone: "process",
  },
  {
    description: "Every returned posting must pass the compiled title rules and accepted-location rules before storage.",
    detail: ["Title accepted", "Location accepted"],
    icon: IconAdjustmentsCheck,
    number: "04",
    scope: "Acceptance gate",
    title: "Check title and location",
    tone: "gate",
  },
  {
    description: "Accepted job records are written to the canonical local Discovery store.",
    detail: ["~/.jobctrl/jobctrl.db"],
    icon: IconDatabase,
    number: "05",
    scope: "Local SQLite",
    title: "Persist accepted jobs",
    tone: "stored",
  },
  {
    description: "Scoring starts afterward, using the saved posting and the scoring preferences that apply to it.",
    icon: IconChartBar,
    number: "06",
    scope: "Later workflow",
    title: "Score the saved job",
    tone: "next",
  },
] as const;
</script>

<template>
  <figure
    class="discovery-pipeline"
    aria-labelledby="discovery-pipeline-title"
    aria-describedby="discovery-pipeline-description discovery-pipeline-summary"
  >
    <figcaption class="discovery-pipeline__caption">
      <span class="discovery-pipeline__eyebrow">
        <IconTargetArrow aria-hidden="true" :stroke-width="1.8" />
        Discovery path
      </span>
      <strong id="discovery-pipeline-title">Intent narrows the search before anything becomes a saved job.</strong>
      <span id="discovery-pipeline-description">
        JobCtrl crosses the network boundary for configured sources, then accepts and persists matching postings locally.
      </span>
    </figcaption>

    <p id="discovery-pipeline-summary" class="discovery-pipeline__visually-hidden">
      Process summary: compile local target intent; query broad boards or enumerate configured ATS and Workday sources;
      extract and normalize returned postings; accept only postings whose titles and locations match; persist accepted jobs
      in local SQLite; then score those saved jobs in a later workflow.
    </p>

    <div class="discovery-pipeline__legend" role="list" aria-label="Discovery data boundaries">
      <span class="discovery-pipeline__legend-item discovery-pipeline__legend-item--local" role="listitem">
        <IconDeviceDesktop aria-hidden="true" :stroke-width="1.9" />
        JobCtrl processing
      </span>
      <span class="discovery-pipeline__legend-item discovery-pipeline__legend-item--network" role="listitem">
        <IconWorldSearch aria-hidden="true" :stroke-width="1.9" />
        Configured network sources
      </span>
      <span class="discovery-pipeline__legend-item discovery-pipeline__legend-item--stored" role="listitem">
        <IconDatabase aria-hidden="true" :stroke-width="1.9" />
        Persisted locally
      </span>
    </div>

    <ol class="discovery-pipeline__steps" role="list">
      <li
        v-for="(stage, index) in stages"
        :key="stage.number"
        class="discovery-pipeline__step"
        :class="`discovery-pipeline__step--${stage.tone}`"
      >
        <span class="discovery-pipeline__number" aria-hidden="true">{{ stage.number }}</span>

        <div class="discovery-pipeline__card">
          <span class="discovery-pipeline__icon" aria-hidden="true">
            <component :is="stage.icon" :stroke-width="1.8" />
          </span>

          <span class="discovery-pipeline__copy">
            <strong>{{ stage.title }}</strong>
            <span>{{ stage.description }}</span>
            <span v-if="stage.detail" class="discovery-pipeline__details">
              <span v-for="detail in stage.detail" :key="detail">{{ detail }}</span>
            </span>
          </span>

          <span class="discovery-pipeline__scope">{{ stage.scope }}</span>
        </div>

        <span v-if="index < stages.length - 1" class="discovery-pipeline__connector" aria-hidden="true">
          <IconArrowDown :stroke-width="2" />
        </span>
      </li>
    </ol>
  </figure>
</template>

<style scoped>
.discovery-pipeline {
  --discovery-border: color-mix(in oklab, var(--vp-c-brand-1), var(--vp-c-divider) 62%);
  --discovery-panel: color-mix(in oklab, var(--vp-c-bg-soft), var(--vp-c-bg) 52%);
  --discovery-card: var(--vp-c-bg);
  --discovery-text: var(--vp-c-text-1);
  --discovery-muted: var(--vp-c-text-2);
  --discovery-local: var(--vp-c-brand-1);
  --discovery-local-soft: var(--vp-c-brand-soft);
  --discovery-network: #b45309;
  --discovery-network-soft: #fffbeb;
  --discovery-stored: #047857;
  --discovery-stored-soft: #ecfdf5;
  --discovery-next: #6d28d9;
  --discovery-next-soft: #f5f3ff;
  position: relative;
  display: grid;
  gap: 1rem;
  inline-size: min(100%, 52rem);
  margin: 1.5rem auto 2rem;
  padding: clamp(0.9rem, 2.5vw, 1.35rem);
  overflow: hidden;
  border: 1px solid var(--discovery-border);
  border-radius: 1.2rem;
  background:
    radial-gradient(circle at 94% 3%, color-mix(in oklab, var(--discovery-network-soft), transparent 24%), transparent 28%),
    radial-gradient(circle at 4% 94%, color-mix(in oklab, var(--discovery-stored-soft), transparent 28%), transparent 32%),
    var(--discovery-panel);
  box-shadow: 0 16px 42px color-mix(in srgb, #0f172a 10%, transparent);
  color: var(--discovery-text);
}

:global(.dark) .discovery-pipeline {
  --discovery-network: #fbbf24;
  --discovery-network-soft: color-mix(in oklab, #78350f, var(--vp-c-bg) 58%);
  --discovery-stored: #34d399;
  --discovery-stored-soft: color-mix(in oklab, #064e3b, var(--vp-c-bg) 52%);
  --discovery-next: #c4b5fd;
  --discovery-next-soft: color-mix(in oklab, #4c1d95, var(--vp-c-bg) 62%);
  box-shadow: 0 18px 48px rgb(0 0 0 / 0.28);
}

.discovery-pipeline__caption {
  display: grid;
  gap: 0.35rem;
  max-inline-size: 48rem;
}

.discovery-pipeline__caption > strong {
  color: var(--discovery-text);
  font-size: clamp(1.15rem, 3vw, 1.5rem);
  line-height: 1.2;
  letter-spacing: -0.025em;
  text-wrap: balance;
}

.discovery-pipeline__caption > span:last-child {
  color: var(--discovery-muted);
  line-height: 1.5;
  text-wrap: pretty;
}

.discovery-pipeline__eyebrow,
.discovery-pipeline__legend-item,
.discovery-pipeline__scope,
.discovery-pipeline__details {
  display: inline-flex;
  align-items: center;
}

.discovery-pipeline__eyebrow {
  gap: 0.4rem;
  color: var(--discovery-local);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.discovery-pipeline__eyebrow :deep(svg) {
  inline-size: 1rem;
  block-size: 1rem;
}

.discovery-pipeline__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.discovery-pipeline__legend-item {
  gap: 0.35rem;
  min-block-size: 1.85rem;
  padding-inline: 0.62rem;
  border: 1px solid currentColor;
  border-radius: 999px;
  background: var(--discovery-card);
  font-size: 0.7rem;
  font-weight: 750;
}

.discovery-pipeline__legend-item :deep(svg) {
  inline-size: 0.95rem;
  block-size: 0.95rem;
}

.discovery-pipeline__legend-item--local {
  color: var(--discovery-local);
}

.discovery-pipeline__legend-item--network {
  color: var(--discovery-network);
}

.discovery-pipeline__legend-item--stored {
  color: var(--discovery-stored);
}

.discovery-pipeline__steps {
  display: grid;
  gap: 0;
  margin: 0 !important;
  padding: 0 !important;
  list-style: none !important;
}

.discovery-pipeline__step {
  display: grid;
  grid-template-columns: 2.25rem minmax(0, 1fr);
  gap: 0 0.7rem;
  align-items: start;
  margin: 0;
}

.discovery-pipeline__number {
  z-index: 1;
  display: grid;
  inline-size: 2.25rem;
  block-size: 2.25rem;
  place-items: center;
  margin-block-start: 0.7rem;
  border: 1px solid currentColor;
  border-radius: 0.72rem;
  background: var(--discovery-local-soft);
  color: var(--discovery-local);
  font-size: 0.67rem;
  font-weight: 850;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.05em;
}

.discovery-pipeline__card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 0.75rem;
  align-items: start;
  min-inline-size: 0;
  padding: 0.72rem 0.78rem;
  border: 1px solid var(--discovery-border);
  border-inline-start: 3px solid var(--discovery-local);
  border-radius: 0.85rem;
  background: color-mix(in oklab, var(--discovery-card), transparent 1%);
  box-shadow: 0 5px 16px color-mix(in srgb, #0f172a 6%, transparent);
}

.discovery-pipeline__icon {
  display: grid;
  inline-size: 2.35rem;
  block-size: 2.35rem;
  place-items: center;
  border: 1px solid currentColor;
  border-radius: 0.7rem;
  background: var(--discovery-local-soft);
  color: var(--discovery-local);
}

.discovery-pipeline__icon :deep(svg) {
  inline-size: 1.3rem;
  block-size: 1.3rem;
}

.discovery-pipeline__copy {
  display: grid;
  gap: 0.14rem;
  min-inline-size: 0;
}

.discovery-pipeline__copy > strong {
  color: var(--discovery-text);
  font-size: 0.91rem;
  line-height: 1.3;
}

.discovery-pipeline__copy > span:not(.discovery-pipeline__details) {
  color: var(--discovery-muted);
  font-size: 0.76rem;
  line-height: 1.42;
  text-wrap: pretty;
}

.discovery-pipeline__scope {
  min-block-size: 1.55rem;
  padding-inline: 0.48rem;
  border: 1px solid currentColor;
  border-radius: 999px;
  color: var(--discovery-local);
  font-size: 0.63rem;
  font-weight: 800;
  white-space: nowrap;
}

.discovery-pipeline__details {
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-block-start: 0.3rem;
}

.discovery-pipeline__details > span {
  padding: 0.18rem 0.4rem;
  border-radius: 0.4rem;
  background: var(--discovery-panel);
  color: var(--discovery-muted);
  font-size: 0.65rem;
  font-weight: 700;
  line-height: 1.25;
}

.discovery-pipeline__connector {
  display: grid;
  grid-column: 1;
  inline-size: 1.5rem;
  block-size: 1.5rem;
  place-items: center;
  justify-self: center;
  color: var(--discovery-local);
}

.discovery-pipeline__connector :deep(svg) {
  inline-size: 1rem;
  block-size: 1rem;
}

.discovery-pipeline__step--network .discovery-pipeline__number,
.discovery-pipeline__step--network .discovery-pipeline__icon {
  background: var(--discovery-network-soft);
  color: var(--discovery-network);
}

.discovery-pipeline__step--network .discovery-pipeline__card {
  border-style: dashed;
  border-inline-start-style: solid;
  border-inline-start-color: var(--discovery-network);
}

.discovery-pipeline__step--network .discovery-pipeline__scope,
.discovery-pipeline__step--network .discovery-pipeline__connector {
  color: var(--discovery-network);
}

.discovery-pipeline__step--stored .discovery-pipeline__number,
.discovery-pipeline__step--stored .discovery-pipeline__icon {
  background: var(--discovery-stored-soft);
  color: var(--discovery-stored);
}

.discovery-pipeline__step--stored .discovery-pipeline__card {
  border-inline-start-color: var(--discovery-stored);
}

.discovery-pipeline__step--stored .discovery-pipeline__scope,
.discovery-pipeline__step--stored .discovery-pipeline__connector {
  color: var(--discovery-stored);
}

.discovery-pipeline__step--next .discovery-pipeline__number,
.discovery-pipeline__step--next .discovery-pipeline__icon {
  background: var(--discovery-next-soft);
  color: var(--discovery-next);
}

.discovery-pipeline__step--next .discovery-pipeline__card {
  border-inline-start-color: var(--discovery-next);
}

.discovery-pipeline__step--next .discovery-pipeline__scope {
  color: var(--discovery-next);
}

.discovery-pipeline__visually-hidden {
  position: absolute !important;
  inline-size: 1px !important;
  block-size: 1px !important;
  margin: -1px !important;
  padding: 0 !important;
  overflow: hidden !important;
  border: 0 !important;
  clip-path: inset(50%) !important;
  white-space: nowrap !important;
}

@media (max-width: 38rem) {
  .discovery-pipeline {
    padding: 0.75rem;
    border-radius: 1rem;
  }

  .discovery-pipeline__card {
    grid-template-columns: auto minmax(0, 1fr);
    grid-template-areas:
      "icon scope"
      "copy copy";
    gap: 0.45rem 0.65rem;
  }

  .discovery-pipeline__icon {
    grid-area: icon;
  }

  .discovery-pipeline__copy {
    grid-area: copy;
  }

  .discovery-pipeline__scope {
    grid-area: scope;
    justify-self: end;
  }

  .discovery-pipeline__step {
    grid-template-columns: 1.95rem minmax(0, 1fr);
    gap: 0 0.5rem;
  }

  .discovery-pipeline__number {
    inline-size: 1.95rem;
    block-size: 1.95rem;
    margin-block-start: 0.72rem;
    border-radius: 0.62rem;
    font-size: 0.62rem;
  }
}

@media (forced-colors: active) {
  .discovery-pipeline,
  .discovery-pipeline__legend-item,
  .discovery-pipeline__number,
  .discovery-pipeline__card,
  .discovery-pipeline__icon,
  .discovery-pipeline__scope,
  .discovery-pipeline__details > span {
    border-color: CanvasText;
    background: Canvas;
    box-shadow: none;
  }
}
</style>
