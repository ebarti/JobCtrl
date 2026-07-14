<script setup lang="ts">
import {
  IconApi,
  IconArrowDown,
  IconHistory,
  IconKey,
  IconLink,
  IconSend,
  IconShieldLock,
  IconShieldX,
} from "@tabler/icons-vue";

const layers = [
  {
    boundary: "Requests and workers",
    description:
      "Loopback host and peer checks, trusted browser origins, scoped local capability tokens, and worker readiness checks control access to local automation.",
    icon: IconApi,
    title: "Local API & process boundary",
  },
  {
    boundary: "Destinations and tools",
    description:
      "Public HTTP(S) validation plus origin-bound credential typing and artifact upload contain untrusted pages and model output.",
    icon: IconLink,
    title: "Outbound & sensitive-tool binding",
  },
  {
    boundary: "Secrets and model runtimes",
    description:
      "Secrets stay outside SQLite and config; JobCtrl-owned state, filtered environments, and restricted tool and file surfaces isolate execution.",
    icon: IconKey,
    title: "Credential & runtime isolation",
  },
  {
    boundary: "Employer-facing action",
    description:
      "Browser-enforced dry-run, exact approval binding, durable submit intent, atomic claiming, and an at-most-once attempt control submission.",
    icon: IconShieldLock,
    title: "Approval & submission controls",
  },
  {
    boundary: "Evidence and shipped code",
    description:
      "Provenance and events preserve decisions; ambiguous submits park for verification; manifests, privacy scans, signing, and notarization gate releases.",
    icon: IconHistory,
    title: "Audit & release boundary",
  },
] as const;
</script>

<template>
  <figure
    class="security-layers"
    aria-labelledby="security-layers-title"
    aria-describedby="security-layers-description"
  >
    <figcaption class="security-layers__caption">
      <span class="security-layers__eyebrow">
        <IconShieldLock aria-hidden="true" :stroke-width="1.8" />
        Defense in depth
      </span>
      <strong id="security-layers-title">The risky action sits behind independent enforcement layers.</strong>
      <span id="security-layers-description">
        A prompt can guide behavior, but code, process, storage, browser, audit, and release controls define the boundary.
      </span>
    </figcaption>

    <ol class="security-layers__stack" role="list">
      <li v-for="(layer, index) in layers" :key="layer.title" role="listitem">
        <span class="security-layers__number" aria-hidden="true">0{{ index + 1 }}</span>
        <span class="security-layers__icon" aria-hidden="true">
          <component :is="layer.icon" :stroke-width="1.8" />
        </span>
        <span class="security-layers__copy">
          <strong>{{ layer.title }}</strong>
          <span>{{ layer.description }}</span>
        </span>
        <span class="security-layers__boundary">{{ layer.boundary }}</span>
      </li>
    </ol>

    <div class="security-layers__handoff" aria-hidden="true">
      <IconArrowDown :stroke-width="2" />
      <span>Independent enforcement converges here</span>
    </div>

    <section class="security-layers__action" aria-labelledby="security-layers-action-title">
      <span class="security-layers__action-icon" aria-hidden="true">
        <IconSend :stroke-width="1.8" />
      </span>
      <span>
        <strong id="security-layers-action-title">Controlled employer-facing action</strong>
        <span>Missing facts, scope, required approval, or executable readiness stop the path instead of weakening it.</span>
      </span>
      <span class="security-layers__action-state">
        <IconShieldX aria-hidden="true" :stroke-width="1.8" />
        Fail closed
      </span>
    </section>
  </figure>
</template>

<style scoped>
.security-layers {
  --security-border: var(--vp-c-divider);
  --security-panel: var(--vp-c-bg-soft);
  --security-card: var(--vp-c-bg);
  --security-text: var(--vp-c-text-1);
  --security-muted: var(--vp-c-text-2);
  --security-accent: var(--vp-c-brand-1);
  --security-accent-soft: var(--vp-c-brand-soft);
  --security-safe: #047857;
  --security-safe-soft: #ecfdf5;
  display: grid;
  gap: 0.85rem;
  margin-block: 1.5rem 2rem;
  padding: clamp(0.85rem, 2.5vw, 1.35rem);
  overflow: hidden;
  border: 1px solid var(--security-border);
  border-radius: 1.25rem;
  background:
    radial-gradient(circle at 94% 0%, color-mix(in oklab, var(--security-accent-soft), transparent 18%), transparent 31%),
    radial-gradient(circle at 2% 98%, color-mix(in oklab, var(--security-safe-soft), transparent 24%), transparent 32%),
    var(--security-panel);
  box-shadow: 0 16px 42px color-mix(in srgb, #0f172a 11%, transparent);
  color: var(--security-text);
}

:global(.dark) .security-layers {
  --security-safe: #34d399;
  --security-safe-soft: color-mix(in oklab, #064e3b, var(--vp-c-bg) 48%);
  box-shadow: 0 18px 48px rgb(0 0 0 / 0.3);
}

.security-layers__caption {
  display: grid;
  gap: 0.35rem;
  max-inline-size: 52rem;
}

.security-layers__caption > strong {
  font-size: clamp(1.2rem, 3vw, 1.55rem);
  line-height: 1.16;
  letter-spacing: -0.03em;
  text-wrap: balance;
}

.security-layers__caption > span:last-child,
.security-layers__copy > span,
.security-layers__action > span:nth-child(2) > span {
  color: var(--security-muted);
  line-height: 1.45;
}

.security-layers__eyebrow,
.security-layers__boundary,
.security-layers__handoff,
.security-layers__action-state {
  display: inline-flex;
  gap: 0.4rem;
  align-items: center;
}

.security-layers__eyebrow {
  color: var(--security-accent);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.security-layers__eyebrow :deep(svg) {
  inline-size: 1rem;
  block-size: 1rem;
}

.security-layers__stack {
  position: relative;
  display: grid;
  gap: 0.55rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.security-layers__stack::before {
  position: absolute;
  z-index: 0;
  inset-block: 1rem;
  inset-inline-start: 1.55rem;
  inline-size: 1px;
  background: color-mix(in oklab, var(--security-accent), var(--security-border) 48%);
  content: "";
}

.security-layers__stack > li {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  gap: 0.7rem;
  align-items: center;
  min-inline-size: 0;
  padding: 0.72rem;
  border: 1px solid var(--security-border);
  border-inline-start: 3px solid var(--security-accent);
  border-radius: 0.8rem;
  background: color-mix(in oklab, var(--security-card), transparent 1%);
}

.security-layers__stack > li:nth-child(2) {
  margin-inline: 0.3rem;
}

.security-layers__stack > li:nth-child(3) {
  margin-inline: 0.6rem;
}

.security-layers__stack > li:nth-child(4) {
  margin-inline: 0.9rem;
}

.security-layers__stack > li:nth-child(5) {
  margin-inline: 1.2rem;
  border-inline-start-color: var(--security-safe);
}

.security-layers__number {
  display: grid;
  inline-size: 1.7rem;
  block-size: 1.7rem;
  place-items: center;
  border: 1px solid var(--security-border);
  border-radius: 50%;
  background: var(--security-panel);
  color: var(--security-muted);
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.06em;
}

.security-layers__icon,
.security-layers__action-icon {
  display: grid;
  place-items: center;
  border: 1px solid currentColor;
  background: var(--security-accent-soft);
  color: var(--security-accent);
}

.security-layers__icon {
  inline-size: 2.35rem;
  block-size: 2.35rem;
  border-radius: 0.72rem;
}

.security-layers__stack > li:nth-child(5) .security-layers__icon {
  background: var(--security-safe-soft);
  color: var(--security-safe);
}

.security-layers__icon :deep(svg),
.security-layers__action-icon :deep(svg) {
  inline-size: 1.25rem;
  block-size: 1.25rem;
}

.security-layers__copy {
  display: grid;
  gap: 0.16rem;
  min-inline-size: 0;
}

.security-layers__copy > strong {
  font-size: 0.87rem;
  line-height: 1.3;
}

.security-layers__copy > span {
  font-size: 0.73rem;
}

.security-layers__boundary {
  justify-content: center;
  min-block-size: 1.75rem;
  padding-inline: 0.55rem;
  border: 1px solid color-mix(in oklab, var(--security-accent), var(--security-border) 48%);
  border-radius: 999px;
  background: var(--security-accent-soft);
  color: var(--security-accent);
  font-size: 0.7rem;
  font-weight: 800;
  line-height: 1.2;
  text-align: center;
}

.security-layers__stack > li:nth-child(5) .security-layers__boundary {
  border-color: color-mix(in oklab, var(--security-safe), var(--security-border) 48%);
  background: var(--security-safe-soft);
  color: var(--security-safe);
}

.security-layers__handoff {
  flex-direction: column;
  gap: 0.05rem;
  justify-self: center;
  color: var(--security-safe);
}

.security-layers__handoff :deep(svg) {
  inline-size: 1.25rem;
  block-size: 1.25rem;
}

.security-layers__handoff span {
  color: var(--security-muted);
  font-size: 0.7rem;
  font-weight: 750;
}

.security-layers__action {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 0.7rem;
  align-items: center;
  margin-inline: 1.5rem;
  padding: 0.82rem;
  border: 1px solid color-mix(in oklab, var(--security-safe), var(--security-border) 46%);
  border-radius: 0.85rem;
  background: color-mix(in oklab, var(--security-safe-soft), var(--security-card) 55%);
}

.security-layers__action-icon {
  inline-size: 2.55rem;
  block-size: 2.55rem;
  border-radius: 0.78rem;
  background: var(--security-safe-soft);
  color: var(--security-safe);
}

.security-layers__action > span:nth-child(2) {
  display: grid;
  gap: 0.12rem;
}

.security-layers__action > span:nth-child(2) > strong {
  font-size: 0.9rem;
}

.security-layers__action > span:nth-child(2) > span {
  font-size: 0.74rem;
}

.security-layers__action-state {
  justify-content: center;
  min-block-size: 1.85rem;
  padding-inline: 0.6rem;
  border: 1px solid currentColor;
  border-radius: 999px;
  color: var(--security-safe);
  font-size: 0.7rem;
  font-weight: 800;
  white-space: nowrap;
}

.security-layers__action-state :deep(svg) {
  inline-size: 1rem;
  block-size: 1rem;
}

@media (max-width: 44rem) {
  .security-layers__stack > li {
    grid-template-columns: auto auto minmax(0, 1fr);
  }

  .security-layers__boundary {
    grid-column: 2 / -1;
    justify-self: start;
  }

  .security-layers__action {
    grid-template-columns: auto minmax(0, 1fr);
    margin-inline: 0.6rem;
  }

  .security-layers__action-state {
    grid-column: 1 / -1;
    justify-self: start;
  }
}

@media (max-width: 34rem) {
  .security-layers {
    padding: 0.7rem;
    border-radius: 1rem;
  }

  .security-layers__stack > li:nth-child(n) {
    margin-inline: 0;
  }

  .security-layers__stack::before {
    inset-inline-start: 1.4rem;
  }

  .security-layers__stack > li {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .security-layers__number {
    grid-column: 1;
    grid-row: 1;
  }

  .security-layers__icon {
    grid-column: 1;
    grid-row: 2;
  }

  .security-layers__copy {
    grid-column: 2;
    grid-row: 1 / span 2;
  }

  .security-layers__boundary {
    grid-column: 1 / -1;
  }

  .security-layers__action {
    margin-inline: 0;
  }
}

@media (forced-colors: active) {
  .security-layers,
  .security-layers__stack > li,
  .security-layers__number,
  .security-layers__icon,
  .security-layers__boundary,
  .security-layers__action,
  .security-layers__action-icon,
  .security-layers__action-state {
    border-color: CanvasText;
    box-shadow: none;
  }
}
</style>
