<script setup lang="ts">
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowRight,
  IconCircleCheck,
  IconFileCheck,
  IconSend,
  IconShieldCheck,
  IconShieldX,
  IconTestPipe,
  IconUserCheck,
} from "@tabler/icons-vue";

const flowSteps = [
  {
    actor: "You verify · JobCtrl prepares",
    description:
      "JobCtrl selects the current materials, application URL, profile version, and canonical profile answers.",
    icon: IconFileCheck,
    status: "Missing required attestation → stop. JobCtrl never guesses.",
    statusIcon: IconShieldX,
    statusTone: "stop",
    title: "Prepare the exact candidate",
    tone: "human",
  },
  {
    actor: "JobCtrl enforces",
    description:
      "The agent rehearses the route while the browser blocks form submit and other mutating or data-bearing channels.",
    icon: IconTestPipe,
    status: "Submission is physically blocked.",
    statusIcon: IconShieldCheck,
    statusTone: "enforced",
    title: "Dry-run the route",
    tone: "enforced",
  },
  {
    actor: "You decide",
    description:
      "You inspect the rehearsal and bind approval to the exact materials generation, profile version, URL, and evidence.",
    icon: IconUserCheck,
    status: "Human gate: missing or stale scope fails closed.",
    statusIcon: IconShieldX,
    statusTone: "human",
    title: "Review and approve",
    tone: "human",
  },
  {
    actor: "JobCtrl enforces",
    description:
      "After an atomic claim, JobCtrl records durable submit intent and may cross the employer-facing boundary once.",
    icon: IconSend,
    status: "At most once; never a blind retry.",
    statusIcon: IconShieldCheck,
    statusTone: "enforced",
    title: "Make one live attempt",
    tone: "enforced",
  },
] as const;
</script>

<template>
  <figure
    class="apply-safety-flow"
    aria-labelledby="apply-safety-flow-title"
    aria-describedby="apply-safety-flow-description"
  >
    <figcaption class="apply-safety-flow__caption">
      <span class="apply-safety-flow__eyebrow">
        <IconShieldCheck aria-hidden="true" :stroke-width="1.8" />
        Default supervised apply path
      </span>
      <strong id="apply-safety-flow-title">Rehearse first. Approve the exact run. Submit at most once.</strong>
      <span id="apply-safety-flow-description">
        With approval required, human decisions and code-enforced controls alternate before a live submission.
      </span>
    </figcaption>

    <div class="apply-safety-flow__legend" role="list" aria-label="Flow responsibilities">
      <span class="apply-safety-flow__legend-item apply-safety-flow__legend-item--human" role="listitem">
        <IconUserCheck aria-hidden="true" :stroke-width="1.9" />
        Human gate
      </span>
      <span class="apply-safety-flow__legend-item apply-safety-flow__legend-item--enforced" role="listitem">
        <IconShieldCheck aria-hidden="true" :stroke-width="1.9" />
        Code-enforced boundary
      </span>
    </div>

    <ol class="apply-safety-flow__steps" role="list">
      <li
        v-for="(step, index) in flowSteps"
        :key="step.title"
        class="apply-safety-flow__step"
        :class="`apply-safety-flow__step--${step.tone}`"
        role="listitem"
      >
        <div class="apply-safety-flow__card">
          <header class="apply-safety-flow__card-heading">
            <span class="apply-safety-flow__number" aria-hidden="true">0{{ index + 1 }}</span>
            <span class="apply-safety-flow__actor">{{ step.actor }}</span>
          </header>

          <span class="apply-safety-flow__icon" aria-hidden="true">
            <component :is="step.icon" :stroke-width="1.8" />
          </span>

          <div class="apply-safety-flow__copy">
            <strong>{{ step.title }}</strong>
            <span>{{ step.description }}</span>
          </div>

          <p class="apply-safety-flow__status" :class="`apply-safety-flow__status--${step.statusTone}`">
            <component :is="step.statusIcon" aria-hidden="true" :stroke-width="1.9" />
            <span>{{ step.status }}</span>
          </p>
        </div>

        <span v-if="index < flowSteps.length - 1" class="apply-safety-flow__connector" aria-hidden="true">
          <IconArrowRight :stroke-width="1.9" />
        </span>
      </li>
    </ol>

    <div class="apply-safety-flow__outcome-handoff" aria-hidden="true">
      <IconArrowDown :stroke-width="2" />
      <span>Record what happened</span>
    </div>

    <section class="apply-safety-flow__outcomes" aria-labelledby="apply-safety-outcome-title">
      <header>
        <strong id="apply-safety-outcome-title">One attempt, two safe terminal paths</strong>
        <span>An uncertain result is never treated as permission to submit again.</span>
      </header>

      <ul role="list">
        <li class="apply-safety-flow__outcome apply-safety-flow__outcome--recorded" role="listitem">
          <span aria-hidden="true"><IconCircleCheck :stroke-width="1.8" /></span>
          <span>
            <strong>Recorded outcome</strong>
            <span>A confirmed terminal result is written to the local event and read model.</span>
          </span>
        </li>
        <li class="apply-safety-flow__outcome apply-safety-flow__outcome--verify" role="listitem">
          <span aria-hidden="true"><IconAlertTriangle :stroke-width="1.8" /></span>
          <span>
            <strong><code>needs_verification</code></strong>
            <span>An ambiguous crash parks the job for human checking, with no automatic retry.</span>
          </span>
        </li>
      </ul>
    </section>
  </figure>
</template>

<style scoped>
.apply-safety-flow {
  --apply-border: var(--vp-c-divider);
  --apply-panel: var(--vp-c-bg-soft);
  --apply-card: var(--vp-c-bg);
  --apply-text: var(--vp-c-text-1);
  --apply-muted: var(--vp-c-text-2);
  --apply-human: var(--vp-c-brand-1);
  --apply-human-soft: var(--vp-c-brand-soft);
  --apply-enforced: #047857;
  --apply-enforced-soft: #ecfdf5;
  --apply-warning: #b45309;
  --apply-warning-soft: #fffbeb;
  display: grid;
  gap: 0.9rem;
  margin-block: 1.5rem 2rem;
  padding: clamp(0.85rem, 2.5vw, 1.35rem);
  overflow: hidden;
  border: 1px solid var(--apply-border);
  border-radius: 1.25rem;
  background:
    radial-gradient(circle at 96% 0%, color-mix(in oklab, var(--apply-human-soft), transparent 18%), transparent 31%),
    radial-gradient(circle at 3% 100%, color-mix(in oklab, var(--apply-enforced-soft), transparent 24%), transparent 32%),
    var(--apply-panel);
  box-shadow: 0 16px 42px color-mix(in srgb, #0f172a 11%, transparent);
  color: var(--apply-text);
}

:global(.dark) .apply-safety-flow {
  --apply-enforced: #34d399;
  --apply-enforced-soft: color-mix(in oklab, #064e3b, var(--vp-c-bg) 48%);
  --apply-warning: #fbbf24;
  --apply-warning-soft: color-mix(in oklab, #78350f, var(--vp-c-bg) 58%);
  box-shadow: 0 18px 48px rgb(0 0 0 / 0.3);
}

.apply-safety-flow__caption {
  display: grid;
  gap: 0.35rem;
  max-inline-size: 52rem;
}

.apply-safety-flow__caption > strong {
  font-size: clamp(1.2rem, 3vw, 1.55rem);
  line-height: 1.16;
  letter-spacing: -0.03em;
  text-wrap: balance;
}

.apply-safety-flow__caption > span:last-child,
.apply-safety-flow__copy > span,
.apply-safety-flow__outcomes > header > span,
.apply-safety-flow__outcome > span:last-child > span {
  color: var(--apply-muted);
  line-height: 1.45;
}

.apply-safety-flow__eyebrow,
.apply-safety-flow__legend,
.apply-safety-flow__legend-item,
.apply-safety-flow__card-heading,
.apply-safety-flow__status,
.apply-safety-flow__outcome-handoff {
  display: flex;
  align-items: center;
}

.apply-safety-flow__eyebrow {
  gap: 0.4rem;
  color: var(--apply-human);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.apply-safety-flow__eyebrow :deep(svg),
.apply-safety-flow__legend-item :deep(svg) {
  inline-size: 1rem;
  block-size: 1rem;
}

.apply-safety-flow__legend {
  flex-wrap: wrap;
  gap: 0.5rem;
}

.apply-safety-flow__legend-item {
  gap: 0.35rem;
  min-block-size: 1.8rem;
  padding-inline: 0.58rem;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 750;
}

.apply-safety-flow__legend-item--human {
  background: var(--apply-human-soft);
  color: var(--apply-human);
}

.apply-safety-flow__legend-item--enforced {
  background: var(--apply-enforced-soft);
  color: var(--apply-enforced);
}

.apply-safety-flow__steps {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.apply-safety-flow__step {
  position: relative;
  min-inline-size: 0;
}

.apply-safety-flow__card {
  display: grid;
  grid-template-rows: auto auto auto 1fr;
  gap: 0.65rem;
  block-size: 100%;
  min-inline-size: 0;
  padding: 0.8rem;
  border: 1px solid var(--apply-border);
  border-block-start: 3px solid var(--apply-enforced);
  border-radius: 0.85rem;
  background: var(--apply-card);
}

.apply-safety-flow__step--human .apply-safety-flow__card {
  border-block-start-color: var(--apply-human);
}

.apply-safety-flow__card-heading {
  justify-content: space-between;
  gap: 0.4rem;
}

.apply-safety-flow__number {
  color: var(--apply-muted);
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.apply-safety-flow__actor {
  color: var(--apply-enforced);
  font-size: 0.7rem;
  font-weight: 800;
  line-height: 1.25;
  text-align: end;
}

.apply-safety-flow__step--human .apply-safety-flow__actor {
  color: var(--apply-human);
}

.apply-safety-flow__icon {
  display: grid;
  inline-size: 2.45rem;
  block-size: 2.45rem;
  place-items: center;
  border: 1px solid currentColor;
  border-radius: 0.75rem;
  background: var(--apply-enforced-soft);
  color: var(--apply-enforced);
}

.apply-safety-flow__step--human .apply-safety-flow__icon {
  background: var(--apply-human-soft);
  color: var(--apply-human);
}

.apply-safety-flow__icon :deep(svg) {
  inline-size: 1.3rem;
  block-size: 1.3rem;
}

.apply-safety-flow__copy {
  display: grid;
  align-content: start;
  gap: 0.22rem;
  min-inline-size: 0;
}

.apply-safety-flow__copy > strong {
  font-size: 0.9rem;
  line-height: 1.3;
}

.apply-safety-flow__copy > span {
  font-size: 0.74rem;
}

.apply-safety-flow__status {
  align-self: end;
  gap: 0.38rem;
  margin: 0;
  padding-block-start: 0.55rem;
  border-block-start: 1px dashed var(--apply-border);
  color: var(--apply-enforced);
  font-size: 0.7rem;
  font-weight: 750;
  line-height: 1.35;
}

.apply-safety-flow__status--human {
  color: var(--apply-human);
}

.apply-safety-flow__status--stop {
  color: var(--vp-c-danger-1);
}

.apply-safety-flow__status :deep(svg) {
  flex: 0 0 auto;
  inline-size: 1rem;
  block-size: 1rem;
}

.apply-safety-flow__connector {
  position: absolute;
  z-index: 1;
  inset-block-start: 50%;
  inset-inline-end: -1rem;
  display: grid;
  inline-size: 1rem;
  block-size: 1rem;
  place-items: center;
  border-radius: 50%;
  background: var(--apply-panel);
  color: var(--apply-muted);
  transform: translateY(-50%);
}

.apply-safety-flow__connector :deep(svg) {
  inline-size: 1rem;
  block-size: 1rem;
}

.apply-safety-flow__outcome-handoff {
  flex-direction: column;
  gap: 0.05rem;
  justify-self: center;
  color: var(--apply-enforced);
}

.apply-safety-flow__outcome-handoff :deep(svg) {
  inline-size: 1.25rem;
  block-size: 1.25rem;
}

.apply-safety-flow__outcome-handoff span {
  color: var(--apply-muted);
  font-size: 0.7rem;
  font-weight: 750;
}

.apply-safety-flow__outcomes {
  display: grid;
  gap: 0.75rem;
  padding: 0.85rem;
  border: 1px solid var(--apply-border);
  border-radius: 0.9rem;
  background: color-mix(in oklab, var(--apply-card), transparent 2%);
}

.apply-safety-flow__outcomes > header {
  display: grid;
  gap: 0.1rem;
}

.apply-safety-flow__outcomes > header > strong {
  font-size: 0.91rem;
}

.apply-safety-flow__outcomes > header > span {
  font-size: 0.75rem;
}

.apply-safety-flow__outcomes > ul {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.65rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.apply-safety-flow__outcome {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.6rem;
  align-items: center;
  min-inline-size: 0;
  padding: 0.7rem;
  border: 1px solid var(--apply-border);
  border-inline-start: 3px solid var(--apply-enforced);
  border-radius: 0.72rem;
  background: var(--apply-card);
}

.apply-safety-flow__outcome--verify {
  border-inline-start-color: var(--apply-warning);
}

.apply-safety-flow__outcome > span:first-child {
  display: grid;
  inline-size: 2.2rem;
  block-size: 2.2rem;
  place-items: center;
  border-radius: 0.68rem;
  background: var(--apply-enforced-soft);
  color: var(--apply-enforced);
}

.apply-safety-flow__outcome--verify > span:first-child {
  background: var(--apply-warning-soft);
  color: var(--apply-warning);
}

.apply-safety-flow__outcome > span:first-child :deep(svg) {
  inline-size: 1.2rem;
  block-size: 1.2rem;
}

.apply-safety-flow__outcome > span:last-child {
  display: grid;
  gap: 0.12rem;
}

.apply-safety-flow__outcome > span:last-child > strong {
  font-size: 0.84rem;
}

.apply-safety-flow__outcome > span:last-child > span {
  font-size: 0.72rem;
}

@media (max-width: 52rem) {
  .apply-safety-flow__steps {
    grid-template-columns: 1fr;
    gap: 1.35rem;
  }

  .apply-safety-flow__card {
    grid-template-columns: auto minmax(0, 1fr);
    grid-template-rows: auto auto auto;
  }

  .apply-safety-flow__card-heading,
  .apply-safety-flow__status {
    grid-column: 1 / -1;
  }

  .apply-safety-flow__icon {
    grid-column: 1;
    grid-row: 2;
  }

  .apply-safety-flow__copy {
    grid-column: 2;
    grid-row: 2;
  }

  .apply-safety-flow__connector {
    inset-block-start: auto;
    inset-block-end: -1.25rem;
    inset-inline-end: 50%;
    transform: translateX(50%) rotate(90deg);
  }
}

@media (max-width: 34rem) {
  .apply-safety-flow {
    padding: 0.7rem;
    border-radius: 1rem;
  }

  .apply-safety-flow__outcomes > ul {
    grid-template-columns: 1fr;
  }
}

@media (forced-colors: active) {
  .apply-safety-flow,
  .apply-safety-flow__card,
  .apply-safety-flow__outcomes,
  .apply-safety-flow__outcome,
  .apply-safety-flow__legend-item,
  .apply-safety-flow__icon {
    border-color: CanvasText;
    box-shadow: none;
  }
}
</style>
