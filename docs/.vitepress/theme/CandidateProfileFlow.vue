<script setup lang="ts">
import {
  IconAdjustmentsHorizontal,
  IconArrowDown,
  IconBan,
  IconChartDots3,
  IconCircleCheck,
  IconDatabase,
  IconFileText,
  IconLock,
  IconShieldCheck,
  IconSparkles,
  IconVersions,
} from "@tabler/icons-vue";

const consumers = [
  {
    description: "Reads evidence and writes a fit score with its own audit data.",
    icon: IconChartDots3,
    title: "Scoring",
  },
  {
    description: "Reads facts plus policy and writes a new artifact generation.",
    icon: IconFileText,
    title: "Materials",
  },
  {
    description: "Reads approved fields and binds approval to the profile version.",
    icon: IconShieldCheck,
    title: "Apply",
  },
] as const;
</script>

<template>
  <figure
    class="candidate-profile-flow"
    aria-labelledby="candidate-profile-flow-title"
    aria-describedby="candidate-profile-flow-description"
  >
    <figcaption class="candidate-profile-flow__caption">
      <span class="candidate-profile-flow__eyebrow">
        <IconSparkles aria-hidden="true" :stroke-width="1.8" />
        Profile ownership at a glance
      </span>
      <strong id="candidate-profile-flow-title">
        Facts stay canonical. Every downstream run gets a read-only version.
      </strong>
      <span id="candidate-profile-flow-description">
        Preferences constrain how facts may be used; generated work never becomes profile evidence.
      </span>
    </figcaption>

    <div class="candidate-profile-flow__owners">
      <div class="candidate-profile-flow__owner candidate-profile-flow__owner--facts">
        <header class="candidate-profile-flow__owner-heading">
          <span class="candidate-profile-flow__owner-icon" aria-hidden="true">
            <IconDatabase :stroke-width="1.8" />
          </span>
          <span>
            <small>Source of truth · <code>/profile</code></small>
            <strong>Canonical profile facts</strong>
          </span>
        </header>

        <ul class="candidate-profile-flow__fact-list" role="list">
          <li>
            <IconCircleCheck aria-hidden="true" :stroke-width="1.9" />
            Personal and application information
          </li>
          <li>
            <IconCircleCheck aria-hidden="true" :stroke-width="1.9" />
            Experience and education
          </li>
          <li>
            <IconCircleCheck aria-hidden="true" :stroke-width="1.9" />
            Skills and achievement evidence
          </li>
          <li>
            <IconCircleCheck aria-hidden="true" :stroke-width="1.9" />
            Baseline resume content
          </li>
        </ul>

        <p class="candidate-profile-flow__owner-note">
          Saved in normalized Candidate Profile rows in local SQLite.
        </p>
      </div>

      <div class="candidate-profile-flow__owner candidate-profile-flow__owner--policy">
        <header class="candidate-profile-flow__owner-heading">
          <span class="candidate-profile-flow__owner-icon" aria-hidden="true">
            <IconAdjustmentsHorizontal :stroke-width="1.8" />
          </span>
          <span>
            <small>Separate control · <code>/preferences</code></small>
            <strong>Preferences and policy</strong>
          </span>
        </header>

        <ul class="candidate-profile-flow__policy-list" role="list">
          <li>Tailoring permissions</li>
          <li>Writing style</li>
          <li>Resume presentation</li>
        </ul>

        <p class="candidate-profile-flow__owner-note candidate-profile-flow__owner-note--policy">
          <IconLock aria-hidden="true" :stroke-width="1.9" />
          Can constrain use. Cannot create a fact.
        </p>
      </div>
    </div>

    <p class="candidate-profile-flow__handoff">
      <span>Validate, save, and version</span>
      <IconArrowDown aria-hidden="true" :stroke-width="2" />
    </p>

    <div class="candidate-profile-flow__snapshot">
      <span class="candidate-profile-flow__snapshot-icon" aria-hidden="true">
        <IconVersions :stroke-width="1.8" />
      </span>
      <span class="candidate-profile-flow__snapshot-copy">
        <small>Published boundary</small>
        <strong>Immutable <code>ProfileSnapshot</code></strong>
        <span>Validated profile data plus the profile version used by the run.</span>
      </span>
      <span class="candidate-profile-flow__snapshot-badge">
        <IconLock aria-hidden="true" :stroke-width="2" />
        Read-only
      </span>
    </div>

    <p class="candidate-profile-flow__handoff candidate-profile-flow__handoff--consumers">
      <span>Consumed as input</span>
      <IconArrowDown aria-hidden="true" :stroke-width="2" />
    </p>

    <ol class="candidate-profile-flow__consumers" aria-label="Profile snapshot consumers">
      <li v-for="consumer in consumers" :key="consumer.title">
        <span class="candidate-profile-flow__consumer-icon" aria-hidden="true">
          <component :is="consumer.icon" :stroke-width="1.8" />
        </span>
        <span>
          <strong>{{ consumer.title }}</strong>
          <span>{{ consumer.description }}</span>
        </span>
      </li>
    </ol>

    <div class="candidate-profile-flow__guard">
      <span class="candidate-profile-flow__guard-icon" aria-hidden="true">
        <IconBan :stroke-width="1.9" />
      </span>
      <span>
        <strong>No generated output writes facts back.</strong>
        <span>
          Scores, tailored wording, Apply Review drafts, and PDFs stay in their owning contexts.
          Add a true new fact only by editing Profile.
        </span>
      </span>
    </div>
  </figure>
</template>

<style scoped>
.candidate-profile-flow {
  --profile-flow-border: color-mix(in srgb, var(--vp-c-divider) 72%, var(--vp-c-brand-1));
  --profile-flow-card: color-mix(in srgb, var(--vp-c-bg) 94%, var(--vp-c-brand-soft));
  --profile-flow-panel: color-mix(in srgb, var(--vp-c-bg-soft) 84%, var(--vp-c-brand-soft));
  --profile-flow-text: var(--vp-c-text-1);
  --profile-flow-muted: var(--vp-c-text-2);
  --profile-flow-accent: var(--vp-c-brand-1);
  --profile-flow-accent-soft: var(--vp-c-brand-soft);
  --profile-flow-guard: var(--vp-c-danger-1);
  --profile-flow-guard-soft: color-mix(in srgb, var(--vp-c-danger-soft) 78%, var(--vp-c-bg));
  display: grid;
  gap: 0.8rem;
  inline-size: min(48rem, 100%);
  margin: 1.5rem auto 2.25rem;
  padding: clamp(0.85rem, 2.5vw, 1.35rem);
  overflow: clip;
  border: 1px solid var(--profile-flow-border);
  border-radius: 1.25rem;
  background:
    radial-gradient(
      circle at 5% 5%,
      color-mix(in srgb, var(--profile-flow-accent-soft) 82%, transparent),
      transparent 34%
    ),
    radial-gradient(
      circle at 96% 48%,
      color-mix(in srgb, var(--vp-c-bg) 72%, transparent),
      transparent 32%
    ),
    var(--profile-flow-panel);
  box-shadow: 0 16px 44px color-mix(in srgb, var(--vp-c-text-1) 10%, transparent);
  color: var(--profile-flow-text);
}

:global(.dark) .candidate-profile-flow {
  --profile-flow-border: color-mix(in srgb, var(--vp-c-brand-1) 55%, var(--vp-c-divider));
  --profile-flow-card: color-mix(in srgb, var(--vp-c-bg) 91%, var(--vp-c-brand-soft));
  --profile-flow-panel: color-mix(in srgb, var(--vp-c-bg-soft) 91%, var(--vp-c-brand-soft));
  --profile-flow-guard-soft: color-mix(in srgb, var(--vp-c-danger-soft) 62%, var(--vp-c-bg));
  box-shadow: 0 18px 50px rgb(0 0 0 / 0.3);
}

.candidate-profile-flow__caption {
  display: grid;
  gap: 0.35rem;
  max-inline-size: 52rem;
  margin-block-end: 0.25rem;
}

.candidate-profile-flow__caption > strong {
  font-size: clamp(1.2rem, 3vw, 1.55rem);
  line-height: 1.18;
  letter-spacing: -0.03em;
  text-wrap: balance;
}

.candidate-profile-flow__caption > span:last-child {
  color: var(--profile-flow-muted);
  line-height: 1.5;
  text-wrap: pretty;
}

.candidate-profile-flow__eyebrow {
  display: inline-flex;
  gap: 0.4rem;
  align-items: center;
  color: var(--profile-flow-accent);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.candidate-profile-flow__eyebrow :deep(svg) {
  inline-size: 1rem;
  block-size: 1rem;
}

.candidate-profile-flow__owners {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(13rem, 0.85fr);
  gap: 0.75rem;
}

.candidate-profile-flow__owner {
  display: grid;
  min-inline-size: 0;
  padding: 0.9rem;
  border: 1px solid var(--profile-flow-border);
  border-radius: 0.9rem;
  background: var(--profile-flow-card);
  box-shadow: 0 1px 0 color-mix(in srgb, var(--vp-c-text-1) 7%, transparent);
}

.candidate-profile-flow__owner--facts {
  border-inline-start: 0.22rem solid var(--profile-flow-accent);
}

.candidate-profile-flow__owner--policy {
  background: color-mix(in srgb, var(--vp-c-bg) 88%, var(--profile-flow-accent-soft));
}

.candidate-profile-flow__owner-heading {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.7rem;
  align-items: center;
}

.candidate-profile-flow__owner-heading > span:last-child,
.candidate-profile-flow__snapshot-copy,
.candidate-profile-flow__consumers li > span:last-child,
.candidate-profile-flow__guard > span:last-child {
  display: grid;
  gap: 0.15rem;
  min-inline-size: 0;
}

.candidate-profile-flow__owner-heading small,
.candidate-profile-flow__snapshot-copy > small {
  color: var(--profile-flow-accent);
  font-size: 0.69rem;
  font-weight: 750;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.candidate-profile-flow__owner-heading strong {
  font-size: 1rem;
  line-height: 1.3;
}

.candidate-profile-flow__owner-heading code,
.candidate-profile-flow__snapshot code {
  font-size: 0.92em;
  text-transform: none;
}

.candidate-profile-flow__owner-icon,
.candidate-profile-flow__snapshot-icon,
.candidate-profile-flow__consumer-icon,
.candidate-profile-flow__guard-icon {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  border: 1px solid currentColor;
  background: var(--profile-flow-accent-soft);
  color: var(--profile-flow-accent);
}

.candidate-profile-flow__owner-icon {
  inline-size: 2.65rem;
  block-size: 2.65rem;
  border-radius: 0.75rem;
}

.candidate-profile-flow__owner-icon :deep(svg) {
  inline-size: 1.35rem;
  block-size: 1.35rem;
}

.candidate-profile-flow__fact-list,
.candidate-profile-flow__policy-list,
.candidate-profile-flow__consumers {
  margin: 0;
  padding: 0;
  list-style: none;
}

.candidate-profile-flow__fact-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.45rem 0.75rem;
  margin-block-start: 0.85rem;
}

.candidate-profile-flow__fact-list li {
  display: flex;
  gap: 0.38rem;
  align-items: flex-start;
  min-inline-size: 0;
  color: var(--profile-flow-muted);
  font-size: 0.78rem;
  line-height: 1.38;
}

.candidate-profile-flow__fact-list :deep(svg) {
  flex: 0 0 auto;
  inline-size: 0.95rem;
  block-size: 0.95rem;
  margin-block-start: 0.08rem;
  color: var(--profile-flow-accent);
}

.candidate-profile-flow__policy-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.38rem;
  align-content: start;
  margin-block-start: 0.85rem;
}

.candidate-profile-flow__policy-list li {
  padding: 0.22rem 0.48rem;
  border: 1px solid var(--profile-flow-border);
  border-radius: 999px;
  background: var(--vp-c-bg);
  color: var(--profile-flow-muted);
  font-size: 0.7rem;
  font-weight: 650;
  line-height: 1.3;
}

.candidate-profile-flow__owner-note {
  align-self: end;
  margin: 0.75rem 0 0;
  padding-block-start: 0.65rem;
  border-block-start: 1px solid var(--profile-flow-border);
  color: var(--profile-flow-muted);
  font-size: 0.73rem;
  line-height: 1.4;
}

.candidate-profile-flow__owner-note--policy {
  display: flex;
  gap: 0.38rem;
  align-items: flex-start;
  color: var(--profile-flow-text);
  font-weight: 650;
}

.candidate-profile-flow__owner-note--policy :deep(svg) {
  flex: 0 0 auto;
  inline-size: 0.95rem;
  block-size: 0.95rem;
  margin-block-start: 0.08rem;
  color: var(--profile-flow-accent);
}

.candidate-profile-flow__handoff {
  display: grid;
  gap: 0.18rem;
  place-items: center;
  margin: -0.05rem 0;
  color: var(--profile-flow-muted);
  font-size: 0.68rem;
  font-weight: 750;
  letter-spacing: 0.05em;
  line-height: 1.2;
  text-transform: uppercase;
}

.candidate-profile-flow__handoff :deep(svg) {
  inline-size: 1.2rem;
  block-size: 1.2rem;
  color: var(--profile-flow-accent);
}

.candidate-profile-flow__snapshot {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 0.75rem;
  align-items: center;
  inline-size: min(31rem, 100%);
  margin-inline: auto;
  padding: 0.85rem 0.95rem;
  border: 1px solid var(--profile-flow-accent);
  border-radius: 0.95rem;
  background: var(--vp-c-bg);
  box-shadow:
    inset 0 -0.18rem 0 var(--profile-flow-accent-soft),
    0 8px 24px color-mix(in srgb, var(--vp-c-text-1) 8%, transparent);
}

.candidate-profile-flow__snapshot-icon {
  inline-size: 2.9rem;
  block-size: 2.9rem;
  border-radius: 0.82rem;
}

.candidate-profile-flow__snapshot-icon :deep(svg) {
  inline-size: 1.55rem;
  block-size: 1.55rem;
}

.candidate-profile-flow__snapshot-copy > strong {
  font-size: 1rem;
  line-height: 1.3;
}

.candidate-profile-flow__snapshot-copy > span {
  color: var(--profile-flow-muted);
  font-size: 0.76rem;
  line-height: 1.4;
}

.candidate-profile-flow__snapshot-badge {
  display: inline-flex;
  gap: 0.3rem;
  align-items: center;
  padding: 0.28rem 0.5rem;
  border: 1px solid currentColor;
  border-radius: 999px;
  background: var(--profile-flow-accent-soft);
  color: var(--profile-flow-accent);
  font-size: 0.68rem;
  font-weight: 750;
  white-space: nowrap;
}

.candidate-profile-flow__snapshot-badge :deep(svg) {
  inline-size: 0.85rem;
  block-size: 0.85rem;
}

.candidate-profile-flow__consumers {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.65rem;
}

.candidate-profile-flow__consumers li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.55rem;
  min-inline-size: 0;
  padding: 0.72rem;
  border: 1px solid var(--profile-flow-border);
  border-block-start: 0.18rem solid var(--profile-flow-accent);
  border-radius: 0.78rem;
  background: var(--profile-flow-card);
}

.candidate-profile-flow__consumer-icon {
  inline-size: 2.05rem;
  block-size: 2.05rem;
  border-radius: 0.6rem;
}

.candidate-profile-flow__consumer-icon :deep(svg) {
  inline-size: 1.1rem;
  block-size: 1.1rem;
}

.candidate-profile-flow__consumers strong {
  font-size: 0.85rem;
  line-height: 1.3;
}

.candidate-profile-flow__consumers li > span:last-child > span {
  color: var(--profile-flow-muted);
  font-size: 0.72rem;
  line-height: 1.4;
}

.candidate-profile-flow__guard {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.7rem;
  align-items: center;
  padding: 0.8rem 0.9rem;
  border: 1px solid color-mix(in srgb, var(--profile-flow-guard) 68%, var(--vp-c-divider));
  border-radius: 0.85rem;
  background: var(--profile-flow-guard-soft);
}

.candidate-profile-flow__guard-icon {
  inline-size: 2.35rem;
  block-size: 2.35rem;
  border-radius: 999px;
  background: var(--profile-flow-guard-soft);
  color: var(--profile-flow-guard);
}

.candidate-profile-flow__guard-icon :deep(svg) {
  inline-size: 1.3rem;
  block-size: 1.3rem;
}

.candidate-profile-flow__guard strong {
  color: var(--profile-flow-text);
  font-size: 0.82rem;
  line-height: 1.35;
}

.candidate-profile-flow__guard > span:last-child > span {
  color: var(--profile-flow-muted);
  font-size: 0.74rem;
  line-height: 1.42;
}

@media (max-width: 44rem) {
  .candidate-profile-flow__owners,
  .candidate-profile-flow__consumers {
    grid-template-columns: 1fr;
  }

  .candidate-profile-flow__owner--policy {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 0 0.75rem;
  }

  .candidate-profile-flow__owner--policy .candidate-profile-flow__owner-heading,
  .candidate-profile-flow__owner--policy .candidate-profile-flow__owner-note {
    grid-column: 1 / -1;
  }

  .candidate-profile-flow__policy-list {
    grid-column: 1 / -1;
  }

  .candidate-profile-flow__consumers li {
    align-items: center;
  }
}

@media (max-width: 34rem) {
  .candidate-profile-flow {
    padding: 0.75rem;
    border-radius: 1rem;
  }

  .candidate-profile-flow__caption > strong {
    font-size: 1.25rem;
  }

  .candidate-profile-flow__owner {
    padding: 0.75rem;
  }

  .candidate-profile-flow__fact-list {
    grid-template-columns: 1fr;
  }

  .candidate-profile-flow__snapshot {
    grid-template-columns: auto minmax(0, 1fr);
    padding: 0.75rem;
  }

  .candidate-profile-flow__snapshot-badge {
    grid-column: 2;
    justify-self: start;
  }
}

@media (forced-colors: active) {
  .candidate-profile-flow,
  .candidate-profile-flow__owner,
  .candidate-profile-flow__policy-list li,
  .candidate-profile-flow__snapshot,
  .candidate-profile-flow__consumers li,
  .candidate-profile-flow__guard,
  .candidate-profile-flow__owner-icon,
  .candidate-profile-flow__snapshot-icon,
  .candidate-profile-flow__consumer-icon,
  .candidate-profile-flow__guard-icon {
    border-color: CanvasText;
    background: Canvas;
    box-shadow: none;
  }
}
</style>
