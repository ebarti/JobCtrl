<template>
  <figure class="settings-precedence">
    <figcaption class="settings-precedence__caption">
      <span class="settings-precedence__eyebrow">
        <IconSettings aria-hidden="true" />
        Effective-value resolution
      </span>
      <strong>Read from highest to lowest: the first available value wins.</strong>
      <span>Each source is checked only when the source above it has no value.</span>
    </figcaption>

    <div class="settings-precedence__layout">
      <section class="settings-precedence__path" aria-label="Setting resolution order">
        <p class="settings-precedence__path-label">
          <IconArrowDown aria-hidden="true" />
          Resolution path
        </p>

        <ol class="settings-precedence__steps">
          <li class="settings-precedence__step settings-precedence__step--highest">
            <div class="settings-precedence__card">
              <span class="settings-precedence__rank" aria-label="Rank 1, highest priority">
                <strong>01</strong>
                <small>Highest</small>
              </span>
              <span class="settings-precedence__icon" aria-hidden="true">
                <IconPlayerPlay />
              </span>
              <span class="settings-precedence__content">
                <strong>Explicit per-run value</strong>
                <span>Used when the command or workflow supplies one.</span>
                <span class="settings-precedence__source">
                  <IconTerminal2 aria-hidden="true" />
                  Command or workflow input
                </span>
              </span>
            </div>
            <p class="settings-precedence__connector">
              <IconArrowDown aria-hidden="true" />
              <span><strong>No value supplied?</strong> Continue to the saved value.</span>
            </p>
          </li>

          <li class="settings-precedence__step">
            <div class="settings-precedence__card">
              <span class="settings-precedence__rank" aria-label="Rank 2">
                <strong>02</strong>
                <small>Next</small>
              </span>
              <span class="settings-precedence__icon" aria-hidden="true">
                <IconDeviceFloppy />
              </span>
              <span class="settings-precedence__content">
                <strong>Saved UI value</strong>
                <span>Uses the value you last saved in the relevant product surface.</span>
                <span class="settings-precedence__source">
                  <IconDatabase aria-hidden="true" />
                  SQLite or <code>config.json</code>
                </span>
              </span>
            </div>
            <p class="settings-precedence__connector">
              <IconArrowDown aria-hidden="true" />
              <span><strong>Still unset?</strong> Continue to the built-in default.</span>
            </p>
          </li>

          <li class="settings-precedence__step settings-precedence__step--fallback">
            <div class="settings-precedence__card">
              <span class="settings-precedence__rank" aria-label="Rank 3, fallback">
                <strong>03</strong>
                <small>Fallback</small>
              </span>
              <span class="settings-precedence__icon" aria-hidden="true">
                <IconFileCode />
              </span>
              <span class="settings-precedence__content">
                <strong>Built-in default</strong>
                <span>Used only when neither of the higher-priority sources has a value.</span>
                <span class="settings-precedence__source">
                  <IconSettings aria-hidden="true" />
                  Packaged application default
                </span>
              </span>
            </div>
          </li>
        </ol>
      </section>

      <aside class="settings-precedence__safety" aria-labelledby="settings-precedence-safety-title">
        <span class="settings-precedence__safety-kicker">
          <IconShieldX aria-hidden="true" />
          Separate safety cap
        </span>
        <strong id="settings-precedence-safety-title">Hard deny can only force off.</strong>
        <p>After a value resolves, a hard deny switch may disable that feature. It never enables one.</p>
        <p class="settings-precedence__safety-flow">
          <span>Resolved value</span>
          <IconArrowRight aria-hidden="true" />
          <span>Deny check</span>
        </p>
      </aside>
    </div>

    <p class="settings-precedence__scope-note">
      <IconTerminal2 aria-hidden="true" />
      <span><strong>Outside this hierarchy:</strong> non-secret environment variables are not a configuration layer.</span>
    </p>
  </figure>
</template>

<script setup lang="ts">
import {
  IconArrowDown,
  IconArrowRight,
  IconDatabase,
  IconDeviceFloppy,
  IconFileCode,
  IconPlayerPlay,
  IconSettings,
  IconShieldX,
  IconTerminal2,
} from "@tabler/icons-vue";
</script>

<style scoped>
.settings-precedence {
  --settings-precedence-border: color-mix(in srgb, var(--vp-c-divider) 76%, var(--vp-c-brand-1));
  --settings-precedence-panel: color-mix(in srgb, var(--vp-c-bg-soft) 82%, var(--vp-c-brand-soft));
  --settings-precedence-muted: var(--vp-c-text-2);
  --settings-precedence-strong: var(--vp-c-text-1);
  --settings-precedence-rail: color-mix(in srgb, var(--vp-c-brand-1) 58%, transparent);
  --settings-precedence-safety: color-mix(in srgb, var(--vp-c-danger-soft) 76%, var(--vp-c-bg));
  --settings-precedence-safety-border: color-mix(in srgb, var(--vp-c-danger-1) 70%, var(--vp-c-divider));
  margin-block: 1.5rem 2rem;
  color: var(--settings-precedence-strong);
}

:global(.dark) .settings-precedence {
  --settings-precedence-border: color-mix(in srgb, var(--vp-c-brand-1) 52%, var(--vp-c-divider));
  --settings-precedence-panel: color-mix(in srgb, var(--vp-c-bg-soft) 88%, var(--vp-c-brand-soft));
  --settings-precedence-rail: color-mix(in srgb, var(--vp-c-brand-1) 76%, transparent);
  --settings-precedence-safety: color-mix(in srgb, var(--vp-c-danger-soft) 62%, var(--vp-c-bg));
  --settings-precedence-safety-border: color-mix(in srgb, var(--vp-c-danger-1) 78%, var(--vp-c-divider));
}

.settings-precedence__caption {
  display: grid;
  gap: 0.35rem;
  max-inline-size: 48rem;
  margin-block-end: 1rem;
}

.settings-precedence__caption > strong {
  font-size: 1.1rem;
  line-height: 1.35;
}

.settings-precedence__caption > span:last-child,
.settings-precedence__content > span:not(.settings-precedence__source),
.settings-precedence__safety > p,
.settings-precedence__scope-note {
  color: var(--settings-precedence-muted);
}

.settings-precedence__eyebrow,
.settings-precedence__path-label,
.settings-precedence__safety-kicker,
.settings-precedence__source,
.settings-precedence__scope-note,
.settings-precedence__safety-flow {
  display: inline-flex;
  gap: 0.45rem;
  align-items: center;
}

.settings-precedence__eyebrow,
.settings-precedence__path-label,
.settings-precedence__safety-kicker {
  color: var(--vp-c-brand-1);
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.settings-precedence__eyebrow :deep(svg),
.settings-precedence__path-label :deep(svg),
.settings-precedence__safety-kicker :deep(svg) {
  inline-size: 1rem;
  block-size: 1rem;
}

.settings-precedence__layout {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(13.5rem, 0.8fr);
  gap: 1rem;
  align-items: stretch;
}

.settings-precedence__path,
.settings-precedence__safety {
  border: 1px solid var(--settings-precedence-border);
  border-radius: 1rem;
}

.settings-precedence__path {
  padding: 1rem;
  background: var(--settings-precedence-panel);
}

.settings-precedence__path-label {
  margin: 0 0 0.85rem;
}

.settings-precedence__steps {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.settings-precedence__step {
  position: relative;
  display: grid;
  gap: 0.5rem;
}

.settings-precedence__card {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  gap: 0.7rem;
  align-items: start;
  padding: 0.8rem;
  border: 1px solid var(--settings-precedence-border);
  border-radius: 0.75rem;
  background: var(--vp-c-bg);
  box-shadow: 0 1px 0 color-mix(in srgb, var(--vp-c-text-1) 7%, transparent);
}

.settings-precedence__step--highest .settings-precedence__card {
  border-color: var(--vp-c-brand-1);
  box-shadow: inset 0.2rem 0 0 var(--vp-c-brand-1), 0 1px 0 color-mix(in srgb, var(--vp-c-text-1) 7%, transparent);
}

.settings-precedence__rank {
  display: grid;
  gap: 0.05rem;
  min-inline-size: 2.1rem;
  padding-inline-end: 0.55rem;
  border-inline-end: 1px solid var(--settings-precedence-border);
  color: var(--vp-c-brand-1);
  text-align: center;
}

.settings-precedence__rank > strong {
  font-size: 0.93rem;
  line-height: 1;
}

.settings-precedence__rank > small {
  color: var(--settings-precedence-muted);
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.settings-precedence__icon {
  display: grid;
  place-items: center;
  inline-size: 2rem;
  block-size: 2rem;
  border-radius: 0.55rem;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}

.settings-precedence__icon :deep(svg) {
  inline-size: 1.2rem;
  block-size: 1.2rem;
}

.settings-precedence__content {
  display: grid;
  gap: 0.18rem;
  min-inline-size: 0;
  line-height: 1.35;
}

.settings-precedence__content > strong {
  font-size: 0.96rem;
}

.settings-precedence__source {
  gap: 0.32rem;
  margin-block-start: 0.28rem;
  color: var(--settings-precedence-muted);
  font-size: 0.78rem;
  font-weight: 600;
}

.settings-precedence__source :deep(svg) {
  flex: 0 0 auto;
  inline-size: 0.9rem;
  block-size: 0.9rem;
}

.settings-precedence__source code {
  font-size: 0.95em;
}

.settings-precedence__connector {
  display: flex;
  gap: 0.38rem;
  align-items: center;
  margin: 0 0 0 1.1rem;
  padding-block: 0.08rem 0.45rem;
  border-inline-start: 1px dashed var(--settings-precedence-rail);
  color: var(--settings-precedence-muted);
  font-size: 0.76rem;
  line-height: 1.3;
}

.settings-precedence__connector :deep(svg) {
  flex: 0 0 auto;
  inline-size: 1rem;
  block-size: 1rem;
  margin-inline-start: -0.5rem;
  color: var(--vp-c-brand-1);
}

.settings-precedence__connector strong {
  color: var(--settings-precedence-strong);
}

.settings-precedence__safety {
  display: grid;
  align-content: start;
  gap: 0.65rem;
  padding: 1rem;
  border-color: var(--settings-precedence-safety-border);
  background: var(--settings-precedence-safety);
}

.settings-precedence__safety-kicker {
  color: var(--vp-c-danger-1);
}

.settings-precedence__safety > strong {
  font-size: 1rem;
  line-height: 1.3;
}

.settings-precedence__safety > p {
  margin: 0;
  line-height: 1.45;
}

.settings-precedence__safety-flow {
  flex-wrap: wrap;
  padding-block-start: 0.7rem;
  border-block-start: 1px solid var(--settings-precedence-safety-border);
  color: var(--vp-c-danger-1);
  font-size: 0.76rem;
  font-weight: 700;
}

.settings-precedence__safety-flow :deep(svg) {
  inline-size: 1rem;
  block-size: 1rem;
}

.settings-precedence__scope-note {
  gap: 0.55rem;
  margin: 0.85rem 0 0;
  padding: 0.7rem 0.85rem;
  border-inline-start: 0.2rem solid var(--settings-precedence-border);
  background: var(--vp-c-bg-soft);
  font-size: 0.84rem;
  line-height: 1.4;
}

.settings-precedence__scope-note :deep(svg) {
  flex: 0 0 auto;
  inline-size: 1.05rem;
  block-size: 1.05rem;
  color: var(--vp-c-brand-1);
}

@media (max-width: 44rem) {
  .settings-precedence__layout {
    grid-template-columns: 1fr;
  }

  .settings-precedence__safety {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
  }

  .settings-precedence__safety > strong,
  .settings-precedence__safety > p,
  .settings-precedence__safety-flow {
    grid-column: 1 / -1;
  }
}

@media (max-width: 30rem) {
  .settings-precedence__path,
  .settings-precedence__safety {
    padding: 0.75rem;
    border-radius: 0.75rem;
  }

  .settings-precedence__card {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .settings-precedence__rank {
    grid-column: 1 / -1;
    grid-template-columns: auto auto;
    gap: 0.25rem;
    justify-content: start;
    padding: 0 0 0.45rem;
    border: 0;
    border-block-end: 1px solid var(--settings-precedence-border);
    text-align: start;
  }

  .settings-precedence__rank > small {
    align-self: end;
  }

  .settings-precedence__connector {
    margin-inline-start: 0.75rem;
  }
}

@media (forced-colors: active) {
  .settings-precedence__path,
  .settings-precedence__safety,
  .settings-precedence__card,
  .settings-precedence__scope-note {
    border-color: CanvasText;
    box-shadow: none;
  }
}
</style>
