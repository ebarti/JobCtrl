"""Bind explicit claim line IDs and verbatim excerpts to the shipped artifact."""

from __future__ import annotations

import re
from collections.abc import Iterable as IterableABC
from dataclasses import dataclass
from typing import Any

from jobctrl.domain.materials.requirement_coverage import GeneratedClaimMapping
from jobctrl.domain.materials.services import sanitize_text

GROUNDED_COVERAGE_BASIS = "verified_line_ids_v2"

# Ids may contain dots ("node.js", "acme.co"); the trailing component shapes
# (".bullets[N]", ".items[N]") are unambiguous, so backtracking splits correctly.
_EXPERIENCE_LOCATION_RE = re.compile(
    r"^(?:experience|experience_updates)\.(?P<entry_id>[^\[\]]+)\.bullets\[(?P<index>\d+)\]$"
)
_SKILLS_LOCATION_RE = re.compile(
    r"^(?:skills|skill_categories|skill_category_updates)\.(?P<category_id>[^\[\]]+)"
    r"(?:\.items\[\d+\])?$"
)
_SUMMARY_LOCATIONS = frozenset({"executive_profile", "summary", "resume.executive_profile"})
# Mirrors the sentence-indexed alias spellings the payload-surface validator
# canonicalises (``_canonical_claim_location``): "executive_profile.sentence[N]"
# plus the "summary"/"profile."-prefixed and bare-index variants.
_SUMMARY_SENTENCE_LOCATION_RE = re.compile(r"^(?:(?:profile\.)?(?:executive_profile|summary))(?:\.sentences?)?\[\d+\]$")


@dataclass(frozen=True)
class GroundedClaimBinding:
    """One claim bound to the shipped line(s) that carry it."""

    claim_id: str
    requirement_ids: tuple[str, ...]
    evidence_ids: tuple[str, ...]
    bullet_ids: tuple[str, ...]
    via: str  # Explicit generation-time line ID.


@dataclass(frozen=True)
class UngroundedClaim:
    """A coverage-bearing claim whose text ships nowhere in the rendered resume."""

    claim_id: str
    location: str
    requirement_ids: tuple[str, ...]
    reason: str  # "location_not_shipped" | "non_verbatim_claim"


@dataclass(frozen=True)
class ClaimGrounding:
    """The grounded view of one payload's claim mappings against its shipped lines."""

    bindings: tuple[GroundedClaimBinding, ...]
    ungrounded: tuple[UngroundedClaim, ...]
    basis: str = GROUNDED_COVERAGE_BASIS

    @property
    def grounded_requirement_ids(self) -> tuple[str, ...]:
        return tuple(
            dict.fromkeys(requirement_id for binding in self.bindings for requirement_id in binding.requirement_ids)
        )

    @property
    def claimed_only_requirement_ids(self) -> tuple[str, ...]:
        grounded = set(self.grounded_requirement_ids)
        return tuple(
            dict.fromkeys(
                requirement_id
                for claim in self.ungrounded
                for requirement_id in claim.requirement_ids
                if requirement_id not in grounded
            )
        )

    def requirement_ids_for_bullet(self, bullet_id: str) -> tuple[str, ...]:
        return tuple(
            dict.fromkeys(
                requirement_id
                for binding in self.bindings
                if bullet_id in binding.bullet_ids
                for requirement_id in binding.requirement_ids
            )
        )

    def to_metadata(self) -> dict[str, Any]:
        """Inspectable audit record: how every coverage-bearing claim grounded."""
        return {
            "basis": self.basis,
            "grounded_claims": [
                {
                    "claim_id": binding.claim_id,
                    "requirement_ids": list(binding.requirement_ids),
                    "bullet_ids": list(binding.bullet_ids),
                    "via": binding.via,
                }
                for binding in self.bindings
            ],
            "ungrounded_claims": [
                {
                    "claim_id": claim.claim_id,
                    "location": claim.location,
                    "requirement_ids": list(claim.requirement_ids),
                    "reason": claim.reason,
                }
                for claim in self.ungrounded
            ],
            "claimed_only_requirement_ids": list(self.claimed_only_requirement_ids),
        }


def bullet_id_for_claim_location(location: str) -> str | None:
    """Map a claim-mapping location to the provenance bullet id it names, or None.

    Mirrors the alias forms accepted by the payload-surface validator
    (``_generated_claim_surfaces``) and the bullet ids minted by
    ``build_bullet_provenance``. Skill item locations map to the category line —
    provenance audits skills one row per rendered category — and summary
    sentence locations (``executive_profile.sentence[N]`` and its aliases) map
    to the single shipped executive-profile line.
    """
    canonical = re.sub(r"\.bullet\[(\d+)\]$", r".bullets[\1]", str(location or "").strip())
    if canonical in _SUMMARY_LOCATIONS or _SUMMARY_SENTENCE_LOCATION_RE.match(canonical):
        return "executive_profile#0"
    match = _EXPERIENCE_LOCATION_RE.match(canonical)
    if match:
        return f"experience:{match.group('entry_id')}#{match.group('index')}"
    match = _SKILLS_LOCATION_RE.match(canonical)
    if match:
        return f"skills:{match.group('category_id')}#0"
    return None


def ground_claim_mappings(
    mappings: IterableABC[GeneratedClaimMapping], shipped_lines: IterableABC[tuple[str, str]]
) -> ClaimGrounding:
    shipped = dict(shipped_lines)
    bindings, ungrounded = [], []
    for mapping in mappings:
        if not mapping.coverage_edge_ids:
            continue
        line_id = mapping.line_id
        if (
            bullet_id_for_claim_location(mapping.location) == line_id
            and line_id in shipped
            and _claim_binds_line(shipped[line_id], mapping.text)
        ):
            bindings.append(_binding(mapping, (line_id,), via="line_id"))
        else:
            ungrounded.append(
                UngroundedClaim(
                    claim_id=mapping.claim_id,
                    location=mapping.location,
                    requirement_ids=mapping.requirement_ids,
                    reason="location_not_shipped" if line_id not in shipped else "non_verbatim_claim",
                )
            )
    return ClaimGrounding(bindings=tuple(bindings), ungrounded=tuple(ungrounded))


def _binding(
    mapping: GeneratedClaimMapping,
    bullet_ids: tuple[str, ...],
    *,
    via: str,
) -> GroundedClaimBinding:
    return GroundedClaimBinding(
        claim_id=mapping.claim_id,
        requirement_ids=mapping.requirement_ids,
        evidence_ids=mapping.evidence_ids,
        bullet_ids=bullet_ids,
        via=via,
    )


def _claim_binds_line(line_text: str, claim_text: str) -> bool:
    # The generator quotes the same rendering normalization as the assembler.
    quote = sanitize_text(claim_text)
    return bool(quote) and quote in line_text


__all__ = [
    "GROUNDED_COVERAGE_BASIS",
    "ClaimGrounding",
    "GroundedClaimBinding",
    "UngroundedClaim",
    "bullet_id_for_claim_location",
    "ground_claim_mappings",
]
