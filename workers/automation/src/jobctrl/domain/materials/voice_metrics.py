"""Deterministic voice proxies — the measurable VOICE-01 gate (Phase 3).

Voice ("reads like a human, not an LLM") is hard to test, so it silently
regresses unless it is gated by deterministic, reproducible proxies rather than a
vibe (Pitfall 7). This module is the pure, no-LLM gate the voice pass is held to:

  * **Buzzword density** — banned-buzzword / stock-phrase hits over total
    words, against a FOCUSED lexicon (the project's already-curated
    ``BANNED_WORDS`` + ``STOCK_PHRASE_MARKERS``, deduplicated). A high density is
    the single loudest low-quality prose smell.
  * **Structural variety** — the average of (a) opening-token diversity (distinct
    first words / number of bullets — uniform "Spearheaded X… Spearheaded Y…"
    scores near zero) and (b) normalised bullet-length variance (every bullet the
    same length is the template-y smell). Both are crude on purpose; they catch
    the worst regressions cheaply.

The voice pass must MEASURABLY improve at least one proxy vs its input — reduce
buzzword density OR increase structural variety (:func:`measure_voice_delta`).
That is the deterministic acceptance gate the use case applies before it accepts
the voiced payload, independent of the (stochastic) voice LLM.

Pure data, no I/O, no LLM. Unit-tested directly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from statistics import pvariance

from jobctrl.domain.materials.quality import STOCK_PHRASE_MARKERS
from jobctrl.domain.materials.services import BANNED_WORDS

_WORD_RE = re.compile(r"[a-z0-9][a-z0-9+#./'-]*")


def _focused_buzzword_lexicon() -> tuple[str, ...]:
    """The focused banned-buzzword lexicon the density proxy scores against.

    Built from the project's already-curated lists so the gate and the validator
    agree on what "buzzword" means: ``BANNED_WORDS`` (the validator's hard list)
    plus ``STOCK_PHRASE_MARKERS`` (the quality evaluator's stock phrases),
    deduplicated and lowercased, longest-first so a multi-word phrase is matched
    before any single-word substring of it.
    """
    seen: set[str] = set()
    ordered: list[str] = []
    for term in (*BANNED_WORDS, *STOCK_PHRASE_MARKERS):
        normalized = term.strip().lower()
        if normalized and normalized not in seen:
            seen.add(normalized)
            ordered.append(normalized)
    ordered.sort(key=len, reverse=True)
    return tuple(ordered)


# Computed once — the lexicon is static for a process.
BUZZWORD_LEXICON: tuple[str, ...] = _focused_buzzword_lexicon()


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


def _words(text: str) -> list[str]:
    return _WORD_RE.findall(_normalize(text))


def _count_buzzwords(joined_lower: str) -> int:
    """Count buzzword occurrences across the joined bullet text.

    Single-word terms match on a word boundary so ``robust`` does not fire inside
    ``robustness``; multi-word phrases (``cutting-edge``, ``proven track record``)
    match as substrings. Each occurrence counts so repeated buzzwords raise the
    density (keyword-stuffing the buzzwords is itself a smell).
    """
    hits = 0
    for term in BUZZWORD_LEXICON:
        if " " in term or "-" in term:
            hits += joined_lower.count(term)
        else:
            hits += len(
                re.findall(r"(?<![a-z0-9])" + re.escape(term) + r"(?![a-z0-9])", joined_lower)
            )
    return hits


@dataclass(frozen=True)
class VoiceMetrics:
    """Deterministic voice proxies over a set of rendered bullet lines.

    ``buzzword_density`` is buzzword hits / total words (0 when no words).
    ``structural_variety`` is the mean of opening-token diversity and normalised
    length variance, both in ``[0, 1]`` — higher is more human-varied.
    """

    bullet_count: int
    word_count: int
    buzzword_hits: int
    buzzword_density: float
    distinct_opening_ratio: float
    length_variety: float
    structural_variety: float

    @classmethod
    def empty(cls) -> VoiceMetrics:
        return cls(
            bullet_count=0,
            word_count=0,
            buzzword_hits=0,
            buzzword_density=0.0,
            distinct_opening_ratio=0.0,
            length_variety=0.0,
            structural_variety=0.0,
        )

    def to_dict(self) -> dict[str, float | int]:
        return {
            "bullet_count": self.bullet_count,
            "word_count": self.word_count,
            "buzzword_hits": self.buzzword_hits,
            "buzzword_density": round(self.buzzword_density, 6),
            "distinct_opening_ratio": round(self.distinct_opening_ratio, 6),
            "length_variety": round(self.length_variety, 6),
            "structural_variety": round(self.structural_variety, 6),
        }


def compute_voice_metrics(bullets: list[str] | tuple[str, ...]) -> VoiceMetrics:
    """Compute the deterministic voice proxies over a set of bullet lines."""
    cleaned = [_normalize(bullet) for bullet in bullets if _normalize(bullet)]
    if not cleaned:
        return VoiceMetrics.empty()

    joined_lower = "\n".join(cleaned)
    all_words = [word for bullet in cleaned for word in _words(bullet)]
    word_count = len(all_words)
    buzzword_hits = _count_buzzwords(joined_lower)
    buzzword_density = (buzzword_hits / word_count) if word_count else 0.0

    opening_tokens = [bullet_words[0] for bullet in cleaned if (bullet_words := _words(bullet))]
    distinct_opening_ratio = (
        len(set(opening_tokens)) / len(opening_tokens) if opening_tokens else 0.0
    )

    length_variety = _length_variety([len(_words(bullet)) for bullet in cleaned])
    structural_variety = (distinct_opening_ratio + length_variety) / 2.0

    return VoiceMetrics(
        bullet_count=len(cleaned),
        word_count=word_count,
        buzzword_hits=buzzword_hits,
        buzzword_density=buzzword_density,
        distinct_opening_ratio=distinct_opening_ratio,
        length_variety=length_variety,
        structural_variety=structural_variety,
    )


def _length_variety(lengths: list[int]) -> float:
    """Normalise bullet-length variance into ``[0, 1]`` (0 = all identical).

    Uses the coefficient of variation (std / mean) of bullet word-counts, capped
    at 1.0 so one very long bullet cannot peg the metric. A single bullet has no
    variance to measure, so it returns 0 (one line cannot demonstrate variety).
    """
    if len(lengths) < 2:
        return 0.0
    mean = sum(lengths) / len(lengths)
    if mean <= 0:
        return 0.0
    std = pvariance(lengths) ** 0.5
    return min(1.0, std / mean)


@dataclass(frozen=True)
class VoiceMetricsDelta:
    """Before/after comparison the voice pass must satisfy (VOICE-01)."""

    before: VoiceMetrics
    after: VoiceMetrics
    buzzword_density_delta: float  # after - before (negative = fewer buzzwords)
    structural_variety_delta: float  # after - before (positive = more varied)

    @property
    def buzzword_density_reduced(self) -> bool:
        return self.buzzword_density_delta < 0.0

    @property
    def structural_variety_increased(self) -> bool:
        return self.structural_variety_delta > 0.0

    @property
    def improved(self) -> bool:
        """The acceptance gate: voice MEASURABLY reduced buzzwords OR raised variety.

        A pass that does neither (or makes both worse) is not an improvement and
        the use case keeps the pre-voice payload rather than ship a no-op / a
        regression as if it were "voiced".
        """
        return self.buzzword_density_reduced or self.structural_variety_increased

    def to_dict(self) -> dict[str, object]:
        return {
            "before": self.before.to_dict(),
            "after": self.after.to_dict(),
            "buzzword_density_delta": round(self.buzzword_density_delta, 6),
            "structural_variety_delta": round(self.structural_variety_delta, 6),
            "buzzword_density_reduced": self.buzzword_density_reduced,
            "structural_variety_increased": self.structural_variety_increased,
            "improved": self.improved,
        }


def measure_voice_delta(
    before: list[str] | tuple[str, ...],
    after: list[str] | tuple[str, ...],
) -> VoiceMetricsDelta:
    """Compute the voice proxy delta between the pre-voice and voiced bullets."""
    before_metrics = compute_voice_metrics(before)
    after_metrics = compute_voice_metrics(after)
    return VoiceMetricsDelta(
        before=before_metrics,
        after=after_metrics,
        buzzword_density_delta=after_metrics.buzzword_density - before_metrics.buzzword_density,
        structural_variety_delta=after_metrics.structural_variety - before_metrics.structural_variety,
    )


__all__ = [
    "BUZZWORD_LEXICON",
    "VoiceMetrics",
    "VoiceMetricsDelta",
    "compute_voice_metrics",
    "measure_voice_delta",
]
