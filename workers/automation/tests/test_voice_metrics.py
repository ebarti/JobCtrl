"""Deterministic voice proxies — the measurable VOICE-01 gate (Phase 3).

Voice is not a vibe: it is an explicit transform gated by deterministic proxies
(Pitfall 7). These tests pin the two proxies — banned-buzzword density and
structural variety (opening-token diversity + bullet-length variance) — and the
delta contract the voice pass must satisfy: the voiced bullets must measurably
reduce buzzword density OR increase structural variety vs the input. The proxies
are pure and reproducible (no LLM), so they can gate output without a model.
"""

from __future__ import annotations

from jobctrl.domain.materials.voice_metrics import (
    VoiceMetrics,
    compute_voice_metrics,
    measure_voice_delta,
)


def test_buzzword_density_counts_focused_lexicon() -> None:
    """Buzzword density is buzzword hits / total words against the focused lexicon."""
    metrics = compute_voice_metrics(
        ["Spearheaded a robust, scalable, cutting-edge platform leveraging synergy."]
    )
    # "spearheaded", "robust", "cutting-edge", "synergy", "leveraging" all hit.
    assert metrics.buzzword_hits >= 4
    assert metrics.buzzword_density > 0.0


def test_clean_bullets_have_zero_buzzword_density() -> None:
    metrics = compute_voice_metrics(
        ["Cut API latency 40% by replacing synchronous calls with a queue."]
    )
    assert metrics.buzzword_hits == 0
    assert metrics.buzzword_density == 0.0


def test_uniform_template_bullets_have_low_structural_variety() -> None:
    """Every bullet opening with the same verb at the same length = template-y."""
    uniform = [
        "Spearheaded the alpha initiative across the org.",
        "Spearheaded the beta initiative across the org.",
        "Spearheaded the gamma initiative across the org.",
    ]
    metrics = compute_voice_metrics(uniform)
    # One distinct opening token over three bullets => minimal opening diversity.
    assert metrics.distinct_opening_ratio <= 0.34
    assert metrics.structural_variety < 0.5


def test_varied_bullets_have_higher_structural_variety() -> None:
    varied = [
        "Cut API latency 40% by replacing synchronous calls.",
        "Owned the billing service end to end for two years.",
        "When the queue backed up, I rebuilt the consumer to batch writes and added backpressure.",
    ]
    metrics = compute_voice_metrics(varied)
    assert metrics.distinct_opening_ratio == 1.0
    assert metrics.structural_variety > 0.5


def test_empty_input_is_neutral_not_a_crash() -> None:
    metrics = compute_voice_metrics([])
    assert metrics == VoiceMetrics.empty()
    assert metrics.buzzword_density == 0.0
    assert metrics.structural_variety == 0.0


def test_delta_improves_when_buzzwords_removed() -> None:
    before = ["Spearheaded robust cutting-edge synergy across the dynamic org."]
    after = ["Rebuilt the deploy pipeline so releases dropped from an hour to ten minutes."]
    delta = measure_voice_delta(before, after)
    assert delta.buzzword_density_reduced
    assert delta.improved


def test_delta_does_not_accept_synonym_rewrites_for_structure_alone() -> None:
    """Structure is diagnostic, not authority to rewrite already-clean claims."""
    before = [
        "Built the alpha service for the team.",
        "Built the beta service for the team.",
        "Built the gamma service for the team.",
    ]
    after = [
        "Built the alpha service for the team.",
        "Owned billing end to end after the prior lead left.",
        "When latency spiked, I traced it to N+1 queries and batched them.",
    ]
    delta = measure_voice_delta(before, after)
    assert delta.buzzword_density_delta == 0.0  # neither side has buzzwords
    assert delta.structural_variety_increased
    assert not delta.improved


def test_delta_does_not_improve_when_voice_makes_it_worse() -> None:
    """A 'voice' pass that ADDS buzzwords and flattens structure is not an improvement."""
    before = [
        "Cut latency 40% by batching writes.",
        "Owned billing end to end for two years.",
    ]
    after = [
        "Spearheaded robust scalable solutions.",
        "Spearheaded cutting-edge synergy.",
    ]
    delta = measure_voice_delta(before, after)
    assert not delta.improved
