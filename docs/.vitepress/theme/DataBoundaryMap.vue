<script setup lang="ts">
import type { Component } from "vue";
import {
  IconActivityHeartbeat,
  IconArrowDown,
  IconArrowRight,
  IconClockPlay,
  IconDatabase,
  IconDeviceDesktop,
  IconFolders,
  IconPlayerPlay,
  IconRobot,
  IconRoute,
  IconSend,
  IconShieldCheck,
  IconWifi,
  IconWorldSearch,
} from "@tabler/icons-vue";

interface BoundaryItem {
  description: string;
  icon: Component;
  title: string;
}

const localItems: readonly BoundaryItem[] = [
  {
    description: "The web app, loopback API, Temporal, and automation worker run on your computer.",
    icon: IconDeviceDesktop,
    title: "Local processes",
  },
  {
    description: "Profile, jobs, Discovery controls, events, and projections remain in the local SQLite workspace.",
    icon: IconDatabase,
    title: "Canonical data",
  },
  {
    description: "config.json, generated materials, backups, and browser/apply state remain under JOBCTRL_DIR; source-development logs remain in the checkout's .dev directory.",
    icon: IconFolders,
    title: "Workspace files",
  },
] as const;

const externalItems: readonly BoundaryItem[] = [
  {
    description: "Discovery and enrichment send search terms, URLs, and page or API requests to configured sources.",
    icon: IconWorldSearch,
    title: "Job sources and pages",
  },
  {
    description: "Selected providers receive posting text, relevant profile evidence, or generated text for that feature.",
    icon: IconRobot,
    title: "Model providers",
  },
  {
    description: "Employer pages, Gmail, Google Maps, or a CAPTCHA provider receive data only in the flow you use.",
    icon: IconSend,
    title: "Connected actions",
  },
  {
    description: "Metadata-only spans leave the machine only when Langfuse and OpenTelemetry are explicitly configured.",
    icon: IconActivityHeartbeat,
    title: "Optional telemetry",
  },
] as const;
</script>

<template>
  <figure
    class="data-boundary"
    aria-labelledby="data-boundary-title"
    aria-describedby="data-boundary-description data-boundary-summary"
  >
    <figcaption class="data-boundary__caption">
      <span class="data-boundary__eyebrow">
        <IconRoute aria-hidden="true" :stroke-width="1.8" />
        Local product boundary
      </span>
      <strong id="data-boundary-title">Your workspace stays local; configured features cross the boundary only when used.</strong>
      <span id="data-boundary-description">
        A user action or an explicitly enabled schedule opens the boundary only for the feature being used.
      </span>
    </figcaption>

    <p id="data-boundary-summary" class="data-boundary__visually-hidden">
      Data-boundary summary: JobCtrl processes, SQLite data, and workspace files stay on your computer. When you use a
      configured feature, or explicitly enable its schedule or standing loop, that feature may send its relevant data to
      job sources, selected model providers, connected services, or explicitly configured telemetry. Local-first does not
      mean offline.
    </p>

    <section class="data-boundary__triggers" aria-labelledby="data-boundary-trigger-title">
      <div class="data-boundary__section-heading">
        <span class="data-boundary__section-number" aria-hidden="true">01</span>
        <span>
          <strong id="data-boundary-trigger-title">What can start a network-using feature?</strong>
          <small>Each trigger invokes only its configured feature.</small>
        </span>
      </div>

      <div class="data-boundary__trigger-list" role="list">
        <div class="data-boundary__trigger" role="listitem">
          <span class="data-boundary__trigger-icon" aria-hidden="true">
            <IconPlayerPlay :stroke-width="1.8" />
          </span>
          <span>
            <strong>You start or use a feature</strong>
            <small>A run, browser action, provider call, or interactive lookup.</small>
          </span>
        </div>
        <div class="data-boundary__trigger" role="listitem">
          <span class="data-boundary__trigger-icon" aria-hidden="true">
            <IconClockPlay :stroke-width="1.8" />
          </span>
          <span>
            <strong>You enable automation</strong>
            <small>An explicit schedule or standing loop invokes its configured feature.</small>
          </span>
        </div>
      </div>
    </section>

    <div class="data-boundary__trigger-handoff" aria-hidden="true">
      <IconArrowDown :stroke-width="2" />
      <span>Feature request</span>
    </div>

    <div class="data-boundary__map">
      <section class="data-boundary__zone data-boundary__zone--local" aria-labelledby="data-boundary-local-title">
        <header class="data-boundary__zone-heading">
          <span class="data-boundary__zone-icon" aria-hidden="true">
            <IconDeviceDesktop :stroke-width="1.8" />
          </span>
          <span>
            <small>Stays on this computer</small>
            <strong id="data-boundary-local-title">Local workspace</strong>
          </span>
        </header>

        <ul class="data-boundary__items" role="list">
          <li v-for="item in localItems" :key="item.title" class="data-boundary__item">
            <span class="data-boundary__item-icon" aria-hidden="true">
              <component :is="item.icon" :stroke-width="1.8" />
            </span>
            <span>
              <strong>{{ item.title }}</strong>
              <span>{{ item.description }}</span>
            </span>
          </li>
        </ul>
      </section>

      <div class="data-boundary__gate">
        <div class="data-boundary__gate-card">
          <IconShieldCheck aria-hidden="true" :stroke-width="1.8" />
          <strong>Request gate</strong>
          <ul role="list">
            <li>Feature in use</li>
            <li>Service configured</li>
            <li>Data for that feature</li>
          </ul>
        </div>
        <span class="data-boundary__gate-flow" aria-hidden="true">
          <span>Network call</span>
          <IconArrowRight class="data-boundary__gate-arrow--wide" :stroke-width="2" />
          <IconArrowDown class="data-boundary__gate-arrow--narrow" :stroke-width="2" />
        </span>
      </div>

      <section class="data-boundary__zone data-boundary__zone--external" aria-labelledby="data-boundary-external-title">
        <header class="data-boundary__zone-heading">
          <span class="data-boundary__zone-icon" aria-hidden="true">
            <IconWorldSearch :stroke-width="1.8" />
          </span>
          <span>
            <small>May receive feature data</small>
            <strong id="data-boundary-external-title">Configured services</strong>
          </span>
        </header>

        <ul class="data-boundary__items" role="list">
          <li v-for="item in externalItems" :key="item.title" class="data-boundary__item">
            <span class="data-boundary__item-icon" aria-hidden="true">
              <component :is="item.icon" :stroke-width="1.8" />
            </span>
            <span>
              <strong>{{ item.title }}</strong>
              <span>{{ item.description }}</span>
            </span>
          </li>
        </ul>
      </section>
    </div>

    <p class="data-boundary__offline-note">
      <IconWifi aria-hidden="true" :stroke-width="1.8" />
      <span>
        <strong>Local-first does not mean offline.</strong>
        Discovery fetches sources, generation calls models, and live apply contacts an employer when you use those features.
      </span>
    </p>
  </figure>
</template>

<style scoped>
.data-boundary {
  --boundary-border: color-mix(in oklab, var(--vp-c-brand-1), var(--vp-c-divider) 64%);
  --boundary-panel: color-mix(in oklab, var(--vp-c-bg-soft), var(--vp-c-bg) 50%);
  --boundary-card: var(--vp-c-bg);
  --boundary-text: var(--vp-c-text-1);
  --boundary-muted: var(--vp-c-text-2);
  --boundary-local: #047857;
  --boundary-local-soft: #ecfdf5;
  --boundary-external: #b45309;
  --boundary-external-soft: #fffbeb;
  --boundary-gate: var(--vp-c-brand-1);
  --boundary-gate-soft: var(--vp-c-brand-soft);
  position: relative;
  display: grid;
  gap: 0.9rem;
  inline-size: min(100%, 54rem);
  margin: 1.5rem auto 2rem;
  padding: clamp(0.9rem, 2.5vw, 1.35rem);
  overflow: hidden;
  border: 1px solid var(--boundary-border);
  border-radius: 1.2rem;
  background:
    radial-gradient(circle at 0% 48%, color-mix(in oklab, var(--boundary-local-soft), transparent 22%), transparent 29%),
    radial-gradient(circle at 100% 48%, color-mix(in oklab, var(--boundary-external-soft), transparent 22%), transparent 29%),
    var(--boundary-panel);
  box-shadow: 0 16px 42px color-mix(in srgb, #0f172a 10%, transparent);
  color: var(--boundary-text);
}

:global(.dark) .data-boundary {
  --boundary-local: #34d399;
  --boundary-local-soft: color-mix(in oklab, #064e3b, var(--vp-c-bg) 52%);
  --boundary-external: #fbbf24;
  --boundary-external-soft: color-mix(in oklab, #78350f, var(--vp-c-bg) 58%);
  box-shadow: 0 18px 48px rgb(0 0 0 / 0.28);
}

.data-boundary__caption {
  display: grid;
  gap: 0.35rem;
  max-inline-size: 50rem;
}

.data-boundary__caption > strong {
  color: var(--boundary-text);
  font-size: clamp(1.15rem, 3vw, 1.5rem);
  line-height: 1.2;
  letter-spacing: -0.025em;
  text-wrap: balance;
}

.data-boundary__caption > span:last-child,
.data-boundary__section-heading small,
.data-boundary__trigger small,
.data-boundary__item > span:last-child > span,
.data-boundary__offline-note {
  color: var(--boundary-muted);
  line-height: 1.45;
}

.data-boundary__eyebrow,
.data-boundary__trigger-handoff,
.data-boundary__gate-flow,
.data-boundary__offline-note {
  display: inline-flex;
  align-items: center;
}

.data-boundary__eyebrow {
  gap: 0.4rem;
  color: var(--boundary-gate);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.data-boundary__eyebrow :deep(svg) {
  inline-size: 1rem;
  block-size: 1rem;
}

.data-boundary__triggers {
  padding: 0.8rem;
  border: 1px solid var(--boundary-border);
  border-radius: 0.9rem;
  background: color-mix(in oklab, var(--boundary-card), transparent 2%);
}

.data-boundary__section-heading {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.55rem;
  align-items: center;
  margin-block-end: 0.65rem;
}

.data-boundary__section-heading > span:last-child,
.data-boundary__trigger > span:last-child,
.data-boundary__zone-heading > span:last-child,
.data-boundary__item > span:last-child {
  display: grid;
  gap: 0.08rem;
  min-inline-size: 0;
}

.data-boundary__section-number {
  display: grid;
  inline-size: 1.9rem;
  block-size: 1.9rem;
  place-items: center;
  border-radius: 0.6rem;
  background: var(--boundary-gate-soft);
  color: var(--boundary-gate);
  font-size: 0.65rem;
  font-weight: 850;
  font-variant-numeric: tabular-nums;
}

.data-boundary__section-heading strong {
  font-size: 0.88rem;
  line-height: 1.3;
}

.data-boundary__section-heading small {
  font-size: 0.72rem;
}

.data-boundary__trigger-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.55rem;
}

.data-boundary__trigger {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.55rem;
  align-items: center;
  min-inline-size: 0;
  padding: 0.58rem;
  border: 1px solid var(--boundary-border);
  border-radius: 0.72rem;
  background: var(--boundary-panel);
}

.data-boundary__trigger-icon,
.data-boundary__zone-icon,
.data-boundary__item-icon {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid currentColor;
  background: var(--boundary-gate-soft);
  color: var(--boundary-gate);
}

.data-boundary__trigger-icon {
  inline-size: 2rem;
  block-size: 2rem;
  border-radius: 0.62rem;
}

.data-boundary__trigger-icon :deep(svg) {
  inline-size: 1.1rem;
  block-size: 1.1rem;
}

.data-boundary__trigger strong {
  color: var(--boundary-text);
  font-size: 0.78rem;
  line-height: 1.3;
}

.data-boundary__trigger small {
  font-size: 0.67rem;
}

.data-boundary__trigger-handoff {
  justify-self: center;
  gap: 0.35rem;
  color: var(--boundary-gate);
  font-size: 0.66rem;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.data-boundary__trigger-handoff :deep(svg) {
  inline-size: 1rem;
  block-size: 1rem;
}

.data-boundary__map {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(6.2rem, 0.48fr) minmax(0, 1fr);
  gap: 0.65rem;
  align-items: stretch;
}

.data-boundary__zone {
  min-inline-size: 0;
  padding: 0.75rem;
  border: 1px solid currentColor;
  border-radius: 0.9rem;
}

.data-boundary__zone--local {
  background: color-mix(in oklab, var(--boundary-local-soft), var(--boundary-card) 32%);
  color: var(--boundary-local);
}

.data-boundary__zone--external {
  border-style: dashed;
  background: color-mix(in oklab, var(--boundary-external-soft), var(--boundary-card) 32%);
  color: var(--boundary-external);
}

.data-boundary__zone-heading {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.55rem;
  align-items: center;
  margin-block-end: 0.7rem;
}

.data-boundary__zone-icon {
  inline-size: 2.25rem;
  block-size: 2.25rem;
  border-radius: 0.7rem;
}

.data-boundary__zone--local .data-boundary__zone-icon,
.data-boundary__zone--local .data-boundary__item-icon {
  background: var(--boundary-local-soft);
  color: var(--boundary-local);
}

.data-boundary__zone--external .data-boundary__zone-icon,
.data-boundary__zone--external .data-boundary__item-icon {
  background: var(--boundary-external-soft);
  color: var(--boundary-external);
}

.data-boundary__zone-icon :deep(svg) {
  inline-size: 1.25rem;
  block-size: 1.25rem;
}

.data-boundary__zone-heading small {
  color: currentColor;
  font-size: 0.62rem;
  font-weight: 800;
  letter-spacing: 0.04em;
  line-height: 1.25;
  text-transform: uppercase;
}

.data-boundary__zone-heading strong {
  color: var(--boundary-text);
  font-size: 0.88rem;
  line-height: 1.3;
}

.data-boundary__items {
  display: grid;
  gap: 0.45rem;
  margin: 0 !important;
  padding: 0 !important;
  list-style: none !important;
}

.data-boundary__item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.48rem;
  align-items: start;
  min-inline-size: 0;
  margin: 0;
  padding: 0.5rem;
  border: 1px solid color-mix(in oklab, currentColor, var(--boundary-border) 68%);
  border-radius: 0.66rem;
  background: color-mix(in oklab, var(--boundary-card), transparent 2%);
}

.data-boundary__item-icon {
  inline-size: 1.75rem;
  block-size: 1.75rem;
  border-radius: 0.52rem;
}

.data-boundary__item-icon :deep(svg) {
  inline-size: 0.98rem;
  block-size: 0.98rem;
}

.data-boundary__item strong {
  color: var(--boundary-text);
  font-size: 0.72rem;
  line-height: 1.3;
}

.data-boundary__item > span:last-child > span {
  font-size: 0.64rem;
  text-wrap: pretty;
}

.data-boundary__gate {
  display: grid;
  align-content: center;
  gap: 0.65rem;
  min-inline-size: 0;
}

.data-boundary__gate-card {
  display: grid;
  justify-items: center;
  gap: 0.35rem;
  padding: 0.65rem 0.45rem;
  border: 1px solid var(--boundary-gate);
  border-radius: 0.78rem;
  background: var(--boundary-gate-soft);
  color: var(--boundary-gate);
  text-align: center;
}

.data-boundary__gate-card > :deep(svg) {
  inline-size: 1.4rem;
  block-size: 1.4rem;
}

.data-boundary__gate-card > strong {
  color: var(--boundary-text);
  font-size: 0.75rem;
  line-height: 1.25;
}

.data-boundary__gate-card ul {
  display: grid;
  gap: 0.22rem;
  margin: 0 !important;
  padding: 0 !important;
  color: var(--boundary-muted);
  font-size: 0.61rem;
  line-height: 1.3;
  list-style: none !important;
}

.data-boundary__gate-card li::before {
  color: var(--boundary-gate);
  content: "✓ ";
  font-weight: 900;
}

.data-boundary__gate-flow {
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.3rem;
  color: var(--boundary-gate);
  font-size: 0.62rem;
  font-weight: 800;
  text-align: center;
  text-transform: uppercase;
}

.data-boundary__gate-flow :deep(svg) {
  inline-size: 1.1rem;
  block-size: 1.1rem;
}

.data-boundary__gate-arrow--narrow {
  display: none;
}

.data-boundary__offline-note {
  gap: 0.65rem;
  margin: 0;
  padding: 0.72rem 0.8rem;
  border: 1px solid var(--boundary-border);
  border-inline-start: 3px solid var(--boundary-gate);
  border-radius: 0.75rem;
  background: color-mix(in oklab, var(--boundary-card), transparent 2%);
  font-size: 0.74rem;
}

.data-boundary__offline-note :deep(svg) {
  flex: 0 0 auto;
  inline-size: 1.35rem;
  block-size: 1.35rem;
  color: var(--boundary-gate);
}

.data-boundary__offline-note strong {
  color: var(--boundary-text);
}

.data-boundary__visually-hidden {
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
  .data-boundary {
    padding: 0.75rem;
    border-radius: 1rem;
  }

  .data-boundary__trigger-list,
  .data-boundary__map {
    grid-template-columns: 1fr;
  }

  .data-boundary__gate {
    justify-items: center;
  }

  .data-boundary__gate-card {
    inline-size: min(100%, 15rem);
    padding-inline: 0.8rem;
  }

  .data-boundary__gate-flow {
    flex-direction: column;
  }

  .data-boundary__gate-arrow--wide {
    display: none;
  }

  .data-boundary__gate-arrow--narrow {
    display: block;
  }
}

@media (forced-colors: active) {
  .data-boundary,
  .data-boundary__triggers,
  .data-boundary__trigger,
  .data-boundary__zone,
  .data-boundary__zone-icon,
  .data-boundary__item,
  .data-boundary__item-icon,
  .data-boundary__gate-card,
  .data-boundary__offline-note {
    border-color: CanvasText;
    background: Canvas;
    box-shadow: none;
  }
}
</style>
