"""Declared HTML format normalization keeps raw source and exact selected text."""

import html
import json
from dataclasses import replace

import pytest

from jobctrl.infrastructure.enrichment.posting_sources import _description_text, posting_page_sources
from tests.test_job_url_import_workflow import _job_page
from tests.test_posting_source_selection import SelectionModel, extract


@pytest.mark.parametrize("escaped", [False, True])
def test_rich_description_is_normalized_before_exact_span_selection(escaped):
    markup = "<p>Build <strong>reliable</strong> systems.</p><ul><li>Lead engineers.</li></ul>"
    description = html.escape(markup) if escaped else markup
    page = _job_page()
    posting = {**page.json_ld[0], "description": description}
    sources, origins = posting_page_sources(replace(page, json_ld=(posting,)), entity_id=page.url)
    by_id = {source.source_id: source.text for source in sources}
    text = by_id["posting:0:description"]
    assert text == "Build reliable systems. Lead engineers."
    assert json.loads(by_id["posting:0:structured"])["description"] == description
    assert origins["posting:0:description"] == page.url
    selected, receipt = extract(SelectionModel(last_line=0), description=text)
    assert selected.description.value == text
    assert receipt.result["description"]["citations"][0]["quote"] == text


def test_partly_escaped_description_keeps_literal_technical_text():
    assert _description_text("<br>&lt;p&gt;Use &amp;lt;iostream&amp;gt; and x &amp;lt; 3.&lt;/p&gt;") == "Use <iostream> and x < 3."
    assert _description_text("Use &lt;vector&gt;, C++ and x &lt; 3.") == "Use <vector>, C++ and x < 3."
    assert _description_text("<pre>&lt;p&gt;literal markup&lt;/p&gt;</pre>") == "<p>literal markup</p>"
    assert _description_text("<p>Use &lt;iostream&gt;.</p>") == "Use <iostream>."
