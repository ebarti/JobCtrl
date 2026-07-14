<script setup lang="ts">
import {
  IconAdjustmentsHorizontal,
  IconArrowDown,
  IconChecklist,
  IconFileText,
  IconRadar,
  IconRefresh,
  IconRobot,
  IconSend,
  IconShieldCheck,
  IconSparkles,
  IconTestPipe,
  IconUserCircle,
} from "@tabler/icons-vue";

const setupSteps = [
  {
    actor: "You",
    description: "Add accurate experience, skills, preferences, and your baseline resume.",
    icon: IconUserCircle,
    title: "Create your profile",
    tone: "human",
  },
  {
    actor: "You",
    description: "Choose target roles, locations, seniority, and job sources.",
    icon: IconAdjustmentsHorizontal,
    title: "Configure discovery",
    tone: "human",
  },
] as const;

const dailySteps = [
  {
    actor: "JobCtrl",
    description: "Discover, enrich, score, and prepare eligible jobs.",
    icon: IconRadar,
    title: "Find and prepare jobs",
    tone: "agent",
  },
  {
    actor: "You",
    description: "Inspect fit evidence and decide which roles deserve attention.",
    icon: IconChecklist,
    title: "Review jobs and scores",
    tone: "human",
  },
  {
    actor: "You",
    description: "Edit the tailored resume and verify every claim before approval.",
    icon: IconFileText,
    title: "Edit the materials",
    tone: "human",
  },
  {
    actor: "JobCtrl",
    description: "Rehearse the browser path with submission physically blocked.",
    icon: IconTestPipe,
    title: "Run the dry rehearsal",
    tone: "agent",
  },
  {
    actor: "You",
    description: "Approve the exact materials, profile version, URL, and evidence.",
    icon: IconShieldCheck,
    title: "Approve live submission",
    tone: "human",
  },
  {
    actor: "JobCtrl",
    description: "Submit once, verify the outcome, and preserve the audit trail.",
    icon: IconSend,
    title: "Submit and record",
    tone: "agent",
  },
] as const;
</script>

<template>
  <figure
    class="jh-daily-journey"
    aria-labelledby="jh-daily-journey-title"
    aria-describedby="jh-daily-journey-description"
  >
    <figcaption class="jh-daily-journey__caption">
      <span class="jh-daily-journey__eyebrow">
        <IconSparkles aria-hidden="true" :stroke-width="1.8" />
        Workflow at a glance
      </span>
      <strong id="jh-daily-journey-title">Set up once. Then run one supervised loop.</strong>
      <span id="jh-daily-journey-description">
        Every step names who acts. JobCtrl prepares and executes; you review and authorize.
      </span>
    </figcaption>

    <div class="jh-daily-journey__legend" role="list" aria-label="Workflow actors">
      <span class="jh-daily-journey__legend-item jh-daily-journey__legend-item--human" role="listitem">
        <IconUserCircle aria-hidden="true" :stroke-width="1.9" />
        You decide
      </span>
      <span class="jh-daily-journey__legend-item jh-daily-journey__legend-item--agent" role="listitem">
        <IconRobot aria-hidden="true" :stroke-width="1.9" />
        JobCtrl executes
      </span>
    </div>

    <section class="jh-daily-journey__phase jh-daily-journey__phase--setup" aria-labelledby="jh-setup-title">
      <header class="jh-daily-journey__phase-heading">
        <span aria-hidden="true">01</span>
        <div>
          <strong id="jh-setup-title">One-time setup</strong>
          <small>Build the source of truth that every later stage uses.</small>
        </div>
      </header>

      <ol class="jh-daily-journey__steps">
        <li
          v-for="step in setupSteps"
          :key="step.title"
          class="jh-daily-journey__step"
          :class="`jh-daily-journey__step--${step.tone}`"
        >
          <span class="jh-daily-journey__icon" aria-hidden="true">
            <component :is="step.icon" :stroke-width="1.8" />
          </span>
          <span class="jh-daily-journey__copy">
            <strong>{{ step.title }}</strong>
            <span>{{ step.description }}</span>
          </span>
          <span class="jh-daily-journey__actor">{{ step.actor }}</span>
        </li>
      </ol>
    </section>

    <div class="jh-daily-journey__handoff" aria-hidden="true">
      <IconArrowDown :stroke-width="2" />
    </div>

    <section class="jh-daily-journey__phase jh-daily-journey__phase--loop" aria-labelledby="jh-loop-title">
      <header class="jh-daily-journey__phase-heading">
        <span aria-hidden="true">02</span>
        <div>
          <strong id="jh-loop-title">Daily loop</strong>
          <small>Automation advances only as far as your review and approval allow.</small>
        </div>
      </header>

      <ol class="jh-daily-journey__steps">
        <li
          v-for="step in dailySteps"
          :key="step.title"
          class="jh-daily-journey__step"
          :class="`jh-daily-journey__step--${step.tone}`"
        >
          <span class="jh-daily-journey__icon" aria-hidden="true">
            <component :is="step.icon" :stroke-width="1.8" />
          </span>
          <span class="jh-daily-journey__copy">
            <strong>{{ step.title }}</strong>
            <span>{{ step.description }}</span>
          </span>
          <span class="jh-daily-journey__actor">{{ step.actor }}</span>
        </li>
      </ol>

      <div class="jh-daily-journey__repeat">
        <IconRefresh aria-hidden="true" :stroke-width="1.9" />
        <span><strong>Next batch</strong> Return to discovery with the audit trail intact.</span>
      </div>
    </section>
  </figure>
</template>
