<script setup lang="ts">
import {
  IconApi,
  IconArrowDown,
  IconArrowRight,
  IconArrowsExchange,
  IconBrandPython,
  IconBrowser,
  IconCloud,
  IconDatabase,
  IconFileText,
  IconServer2,
  IconTerminal2,
} from "@tabler/icons-vue";
</script>

<template>
  <figure
    class="system-topology"
    aria-labelledby="system-topology-title"
    aria-describedby="system-topology-description"
  >
    <figcaption class="system-topology__caption">
      <span class="system-topology__eyebrow">
        <IconServer2 aria-hidden="true" :stroke-width="1.8" />
        Local runtime topology
      </span>
      <strong id="system-topology-title">Two local entry points, one durable workflow path, three deliberate destinations.</strong>
      <span id="system-topology-description">
        The web app and CLI enter the same workflow system. Python executes the work; SQLite, files,
        and configured services have distinct roles.
      </span>
    </figcaption>

    <section class="system-topology__group system-topology__group--entries" aria-labelledby="topology-entry-title">
      <header class="system-topology__group-heading">
        <span>01</span>
        <div>
          <strong id="topology-entry-title">Entry points</strong>
          <small>Two ways to start or inspect local work.</small>
        </div>
      </header>

      <ol class="system-topology__entries">
        <li class="system-topology__node system-topology__node--web">
          <span class="system-topology__node-icon" aria-hidden="true">
            <IconBrowser :stroke-width="1.8" />
          </span>
          <span class="system-topology__node-copy">
            <strong>Web app</strong>
            <span>Browser</span>
          </span>
        </li>
        <li class="system-topology__node system-topology__node--cli">
          <span class="system-topology__node-icon" aria-hidden="true">
            <IconTerminal2 :stroke-width="1.8" />
          </span>
          <span class="system-topology__node-copy">
            <strong><code>jobctrl</code> CLI</strong>
            <span>Terminal commands</span>
          </span>
        </li>
      </ol>
    </section>

    <div class="system-topology__entry-handoffs" role="group" aria-label="Entry point handoffs">
      <span>
        <IconArrowDown aria-hidden="true" :stroke-width="1.9" />
        Browser requests · SSE
      </span>
      <span>
        <IconArrowDown aria-hidden="true" :stroke-width="1.9" />
        Starts and inspects workflows
      </span>
    </div>

    <section class="system-topology__group system-topology__group--control" aria-labelledby="topology-control-title">
      <header class="system-topology__group-heading">
        <span>02</span>
        <div>
          <strong id="topology-control-title">Control plane</strong>
          <small>Requests become durable workflow work without leaving the local machine.</small>
        </div>
      </header>

      <div class="system-topology__control-flow" role="group" aria-label="Control-plane request flow">
        <div class="system-topology__control-node">
          <span class="system-topology__node-icon" aria-hidden="true">
            <IconApi :stroke-width="1.8" />
          </span>
          <span class="system-topology__node-copy">
            <strong>TypeScript API</strong>
            <span>Fastify · SSE</span>
          </span>
          <small class="system-topology__control-note">Browser requests</small>
        </div>

        <div class="system-topology__connector" aria-hidden="true">
          <span>JSON-RPC commands</span>
          <IconArrowRight :stroke-width="1.9" />
        </div>

        <div class="system-topology__control-node">
          <span class="system-topology__node-icon" aria-hidden="true">
            <IconArrowsExchange :stroke-width="1.8" />
          </span>
          <span class="system-topology__node-copy">
            <strong>Python RPC</strong>
            <span><code>jobctrl rpc</code></span>
          </span>
          <small class="system-topology__control-note">Process boundary</small>
        </div>

        <div class="system-topology__connector" aria-hidden="true">
          <span>Starts workflows</span>
          <IconArrowRight :stroke-width="1.9" />
        </div>

        <div class="system-topology__control-node">
          <span class="system-topology__node-icon" aria-hidden="true">
            <IconServer2 :stroke-width="1.8" />
          </span>
          <span class="system-topology__node-copy">
            <strong>Temporal</strong>
            <span>Workflow engine</span>
          </span>
          <small class="system-topology__control-note">CLI starts and inspects</small>
        </div>
      </div>
    </section>

    <div class="system-topology__worker-handoff" aria-hidden="true">
      <IconArrowDown :stroke-width="2" />
      <span>Task queue</span>
    </div>

    <section class="system-topology__group system-topology__group--worker" aria-labelledby="topology-worker-title">
      <header class="system-topology__group-heading">
        <span>03</span>
        <div>
          <strong id="topology-worker-title">Automation worker</strong>
          <small>Runs workflows and activities under the controls above.</small>
        </div>
      </header>

      <div class="system-topology__worker-card">
        <span class="system-topology__worker-icon" aria-hidden="true">
          <IconBrandPython :stroke-width="1.8" />
        </span>
        <span>
          <strong>Python worker</strong>
          <span>Discovery, enrichment, scoring, materials, and apply activities.</span>
        </span>
        <span class="system-topology__local-badge">Local process</span>
      </div>
    </section>

    <section class="system-topology__group system-topology__group--destinations" aria-labelledby="topology-destination-title">
      <header class="system-topology__group-heading">
        <span>04</span>
        <div>
          <strong id="topology-destination-title">State and controlled boundaries</strong>
          <small>Each destination has a specific ownership and data-handling role.</small>
        </div>
      </header>

      <ol class="system-topology__destinations">
        <li class="system-topology__destination system-topology__destination--database">
          <span class="system-topology__destination-flow" aria-hidden="true">
            <IconArrowDown :stroke-width="1.9" />
            API + worker writes
          </span>
          <span class="system-topology__destination-icon" aria-hidden="true">
            <IconDatabase :stroke-width="1.8" />
          </span>
          <span>
            <strong>Local SQLite</strong>
            <span>Canonical data, events, and projections.</span>
          </span>
        </li>
        <li class="system-topology__destination system-topology__destination--files">
          <span class="system-topology__destination-flow" aria-hidden="true">
            <IconArrowDown :stroke-width="1.9" />
            Creates artifacts
          </span>
          <span class="system-topology__destination-icon" aria-hidden="true">
            <IconFileText :stroke-width="1.8" />
          </span>
          <span>
            <strong>Generated files</strong>
            <span>Resumes, cover letters, and PDFs.</span>
          </span>
        </li>
        <li class="system-topology__destination system-topology__destination--services">
          <span class="system-topology__destination-flow" aria-hidden="true">
            <IconArrowDown :stroke-width="1.9" />
            Controlled calls
          </span>
          <span class="system-topology__destination-icon" aria-hidden="true">
            <IconCloud :stroke-width="1.8" />
          </span>
          <span>
            <strong>Configured services</strong>
            <span>Boards, LLMs, browser, and Gmail.</span>
          </span>
        </li>
      </ol>
    </section>
  </figure>
</template>

<style scoped>
.system-topology {
  --topology-border: var(--vp-c-divider);
  --topology-panel: var(--vp-c-bg-soft);
  --topology-panel-strong: var(--vp-c-bg);
  --topology-text: var(--vp-c-text-1);
  --topology-muted: var(--vp-c-text-2);
  --topology-accent: var(--vp-c-brand-1);
  --topology-accent-soft: var(--vp-c-brand-soft);
  --topology-worker: #047857;
  --topology-worker-soft: #ecfdf5;
  display: grid;
  gap: 0.85rem;
  margin: 1.5rem 0 2rem;
  padding: clamp(0.85rem, 2.5vw, 1.35rem);
  overflow: hidden;
  border: 1px solid var(--topology-border);
  border-radius: 1.25rem;
  background:
    radial-gradient(circle at 94% 0%, color-mix(in oklab, var(--topology-accent-soft), transparent 20%), transparent 30%),
    radial-gradient(circle at 4% 68%, color-mix(in oklab, var(--topology-worker-soft), transparent 24%), transparent 34%),
    var(--topology-panel);
  box-shadow: 0 16px 42px color-mix(in srgb, #0f172a 11%, transparent);
  color: var(--topology-text);
}

:global(.dark) .system-topology {
  --topology-worker: #34d399;
  --topology-worker-soft: color-mix(in oklab, #064e3b, var(--vp-c-bg) 48%);
  box-shadow: 0 18px 48px rgb(0 0 0 / 0.3);
}

.system-topology__caption {
  display: grid;
  gap: 0.35rem;
  max-inline-size: 52rem;
  margin-block-end: 0.25rem;
}

.system-topology__caption > strong {
  font-size: clamp(1.2rem, 3vw, 1.55rem);
  line-height: 1.16;
  letter-spacing: -0.03em;
  text-wrap: balance;
}

.system-topology__caption > span:last-child,
.system-topology__group-heading small,
.system-topology__node-copy > span,
.system-topology__worker-card > span:nth-child(2) > span,
.system-topology__destination > span:last-child > span {
  color: var(--topology-muted);
  line-height: 1.45;
}

.system-topology__eyebrow,
.system-topology__entry-handoffs > span,
.system-topology__destination-flow,
.system-topology__local-badge {
  display: inline-flex;
  gap: 0.4rem;
  align-items: center;
}

.system-topology__eyebrow {
  color: var(--topology-accent);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.system-topology__eyebrow :deep(svg) {
  inline-size: 1rem;
  block-size: 1rem;
}

.system-topology__group {
  padding: clamp(0.75rem, 2vw, 1rem);
  border: 1px solid var(--topology-border);
  border-radius: 0.95rem;
  background: color-mix(in oklab, var(--topology-panel-strong), transparent 2%);
}

.system-topology__group--control {
  border-color: color-mix(in oklab, var(--topology-accent), var(--topology-border) 56%);
}

.system-topology__group--worker {
  border-color: color-mix(in oklab, var(--topology-worker), var(--topology-border) 52%);
}

.system-topology__group-heading {
  display: grid;
  grid-template-columns: 1.95rem minmax(0, 1fr);
  gap: 0.55rem;
  align-items: center;
  margin-block-end: 0.75rem;
}

.system-topology__group-heading > span {
  display: grid;
  inline-size: 1.95rem;
  block-size: 1.95rem;
  place-items: center;
  border-radius: 0.6rem;
  background: var(--topology-accent-soft);
  color: var(--topology-accent);
  font-size: 0.68rem;
  font-weight: 850;
  letter-spacing: 0.06em;
}

.system-topology__group--worker .system-topology__group-heading > span {
  background: var(--topology-worker-soft);
  color: var(--topology-worker);
}

.system-topology__group-heading > div {
  display: grid;
  gap: 0.05rem;
}

.system-topology__group-heading strong {
  font-size: 0.91rem;
  line-height: 1.25;
}

.system-topology__group-heading small {
  font-size: 0.75rem;
}

.system-topology__entries,
.system-topology__destinations {
  display: grid;
  gap: 0.65rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.system-topology__entries {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.system-topology__entry-handoffs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.65rem;
  margin-block: -0.15rem;
}

.system-topology__entry-handoffs > span {
  justify-content: center;
  color: var(--topology-muted);
  font-size: 0.66rem;
  font-weight: 750;
  text-align: center;
}

.system-topology__entry-handoffs > span :deep(svg) {
  inline-size: 1rem;
  block-size: 1rem;
  color: var(--topology-accent);
}

.system-topology__entry-handoffs > span:last-child :deep(svg) {
  color: var(--topology-worker);
}

.system-topology__node,
.system-topology__control-node,
.system-topology__worker-card,
.system-topology__destination {
  min-inline-size: 0;
  border: 1px solid var(--topology-border);
  border-radius: 0.75rem;
  background: var(--topology-panel-strong);
}

.system-topology__node {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.65rem;
  align-items: center;
  padding: 0.7rem;
}

.system-topology__node--web {
  border-inline-start: 3px solid var(--topology-accent);
}

.system-topology__node--cli {
  border-inline-start: 3px solid var(--topology-worker);
}

.system-topology__node-icon,
.system-topology__destination-icon,
.system-topology__worker-icon {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid currentColor;
  background: var(--topology-accent-soft);
  color: var(--topology-accent);
}

.system-topology__node-icon {
  inline-size: 2.3rem;
  block-size: 2.3rem;
  border-radius: 0.7rem;
}

.system-topology__node--cli .system-topology__node-icon {
  background: var(--topology-worker-soft);
  color: var(--topology-worker);
}

.system-topology__node-icon :deep(svg),
.system-topology__destination-icon :deep(svg),
.system-topology__worker-icon :deep(svg) {
  inline-size: 1.25rem;
  block-size: 1.25rem;
}

.system-topology__node-copy,
.system-topology__control-node,
.system-topology__worker-card > span:nth-child(2),
.system-topology__destination > span:last-child {
  display: grid;
  gap: 0.12rem;
}

.system-topology__node-copy strong,
.system-topology__control-node strong,
.system-topology__worker-card strong,
.system-topology__destination strong {
  color: var(--topology-text);
  font-size: 0.86rem;
  line-height: 1.3;
}

.system-topology__node-copy > span,
.system-topology__destination > span:last-child > span {
  font-size: 0.74rem;
}

.system-topology__node-copy code,
.system-topology__control-node code {
  font-size: 0.96em;
}

.system-topology__control-flow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(4.8rem, 0.7fr) minmax(0, 1fr) minmax(4.8rem, 0.7fr) minmax(0, 1fr);
  align-items: stretch;
}

.system-topology__control-node {
  display: grid;
  gap: 0.45rem;
  align-content: start;
  padding: 0.75rem;
}

.system-topology__control-node .system-topology__node-icon {
  margin-block-end: 0.12rem;
}

.system-topology__control-note {
  display: inline-flex;
  inline-size: fit-content;
  margin-block-start: 0.15rem;
  padding: 0.2rem 0.42rem;
  border-radius: 999px;
  background: var(--topology-panel);
  color: var(--topology-muted);
  font-size: 0.66rem;
  font-weight: 700;
  line-height: 1.25;
}

.system-topology__connector {
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 0.3rem;
  min-inline-size: 0;
  padding-inline: 0.25rem;
  color: var(--topology-accent);
  text-align: center;
}

.system-topology__connector::before,
.system-topology__connector::after {
  inline-size: 100%;
  block-size: 1px;
  background: color-mix(in oklab, var(--topology-accent), var(--topology-border) 45%);
  content: "";
}

.system-topology__connector span {
  max-inline-size: 7rem;
  color: var(--topology-muted);
  font-size: 0.66rem;
  font-weight: 700;
  line-height: 1.25;
}

.system-topology__connector :deep(svg) {
  inline-size: 1.15rem;
  block-size: 1.15rem;
  margin-block-start: -0.05rem;
}

.system-topology__worker-handoff {
  display: grid;
  justify-items: center;
  gap: 0.1rem;
  margin-block: -0.1rem;
  color: var(--topology-worker);
}

.system-topology__worker-handoff :deep(svg) {
  inline-size: 1.25rem;
  block-size: 1.25rem;
}

.system-topology__worker-handoff span {
  color: var(--topology-muted);
  font-size: 0.68rem;
  font-weight: 750;
}

.system-topology__worker-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 0.7rem;
  align-items: center;
  padding: 0.8rem;
  border-inline-start: 3px solid var(--topology-worker);
}

.system-topology__worker-icon {
  inline-size: 2.6rem;
  block-size: 2.6rem;
  border-radius: 0.78rem;
  background: var(--topology-worker-soft);
  color: var(--topology-worker);
}

.system-topology__worker-card > span:nth-child(2) > span {
  font-size: 0.76rem;
}

.system-topology__local-badge {
  justify-content: center;
  min-block-size: 1.75rem;
  padding-inline: 0.55rem;
  border: 1px solid color-mix(in oklab, var(--topology-worker), var(--topology-border) 45%);
  border-radius: 999px;
  background: var(--topology-worker-soft);
  color: var(--topology-worker);
  font-size: 0.65rem;
  font-weight: 800;
  white-space: nowrap;
}

.system-topology__destinations {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.system-topology__destination {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.65rem;
  align-items: center;
  padding: 0.75rem;
}

.system-topology__destination-flow {
  grid-column: 1 / -1;
  padding-block-end: 0.45rem;
  border-block-end: 1px dashed var(--topology-border);
  color: var(--topology-muted);
  font-size: 0.66rem;
  font-weight: 750;
}

.system-topology__destination-flow :deep(svg) {
  inline-size: 1rem;
  block-size: 1rem;
  color: var(--topology-worker);
}

.system-topology__destination-icon {
  inline-size: 2.2rem;
  block-size: 2.2rem;
  border-radius: 0.68rem;
}

.system-topology__destination--files .system-topology__destination-icon {
  background: color-mix(in oklab, var(--vp-c-warning-soft), var(--vp-c-bg) 24%);
  color: var(--vp-c-warning-1);
}

.system-topology__destination--services .system-topology__destination-icon {
  background: var(--topology-worker-soft);
  color: var(--topology-worker);
}

@media (max-width: 46rem) {
  .system-topology__control-flow {
    grid-template-columns: 1fr;
    gap: 0.4rem;
  }

  .system-topology__connector {
    grid-template-columns: auto auto auto;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    min-block-size: 1.9rem;
    padding-block: 0.1rem;
  }

  .system-topology__connector::before,
  .system-topology__connector::after {
    inline-size: 2.25rem;
  }

  .system-topology__connector :deep(svg) {
    grid-column: 2;
    grid-row: 1;
    transform: rotate(90deg);
  }

  .system-topology__connector span {
    grid-column: 2;
    grid-row: 2;
  }

  .system-topology__connector::before {
    grid-column: 1;
    grid-row: 1;
  }

  .system-topology__connector::after {
    grid-column: 3;
    grid-row: 1;
  }

  .system-topology__destinations {
    grid-template-columns: 1fr;
  }

  .system-topology__entry-handoffs {
    grid-template-columns: 1fr;
    gap: 0.15rem;
  }

  .system-topology__destination {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .system-topology__destination-flow {
    grid-column: 1 / -1;
  }
}

@media (max-width: 30rem) {
  .system-topology {
    padding: 0.7rem;
    border-radius: 1rem;
  }

  .system-topology__entries {
    grid-template-columns: 1fr;
  }

  .system-topology__worker-card {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .system-topology__local-badge {
    grid-column: 1 / -1;
    justify-self: start;
  }
}

@media (forced-colors: active) {
  .system-topology,
  .system-topology__group,
  .system-topology__node,
  .system-topology__control-node,
  .system-topology__worker-card,
  .system-topology__destination {
    border-color: CanvasText;
    box-shadow: none;
  }
}
</style>
