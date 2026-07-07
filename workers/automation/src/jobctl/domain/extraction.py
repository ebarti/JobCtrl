"""Shared LLM-response JSON parsing helper.

Moved out of ``jobctl.discovery.smartextract`` (Phase 7 / S-27) so
the Enrichment context's extractors can use it without importing from
a sibling bounded context — the Briefing #12 pain point this refactor
targets.

The helper is intentionally context-agnostic — both Discovery (smart
extract) and Enrichment (Tier-3 LLM extractor) need the same
"strip-fences-and-think-tags-then-json.loads" routine, and neither
context owns it.
"""

from __future__ import annotations

import json
import re


def extract_json(text: str) -> dict:
    """Extract a JSON object from a free-form LLM response.

    Handles three common LLM-output quirks:

      * ``<think>…</think>`` reasoning tags (Qwen / Mistral chain-of-
        thought outputs that prepend the answer).
      * Markdown code fences (triple-backtick ``json`` … triple-backtick).
      * Trailing prose after the JSON object (we strip trailing chars
        until ``json.loads`` succeeds — when the LLM appends an
        unrequested explanatory paragraph).

    Raises ``json.JSONDecodeError`` if no parseable JSON can be
    recovered. The caller is expected to log + handle the failure.
    """
    if "<think>" in text:
        after = text.split("</think>")[-1].strip()
        if after:
            text = after
    if "```json" in text:
        text = text.split("```json")[1].split("```")[0]
    elif "```" in text:
        text = text.split("```")[1].split("```")[0]
    text = text.strip()
    text = re.sub(r'\\([^"\\\/bfnrtu])', r'\1', text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    while text.endswith("}") or text.endswith("]"):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            text = text[:-1].rstrip()
    raise json.JSONDecodeError("Could not parse JSON", text, 0)
