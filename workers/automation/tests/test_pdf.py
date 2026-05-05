"""Tests for LaTeX-based PDF generation."""

import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from jobhunter.scoring.pdf import (
    DEFAULT_RESUME_LATEX_TEMPLATE,
    _escape_latex,
    _escape_latex_light,
    _find_pdflatex,
    build_latex,
    render_pdf_latex,
    validate_latex_template,
)


# ── Fixtures ─────────────────────────────────────────────────────────────

@pytest.fixture
def minimal_profile():
    """Minimal profile matching the canonical schema."""
    return {
        "personal": {
            "full_name": "Jane Doe",
            "email": "jane@example.com",
            "phone": "+1-555-0100",
            "address": "123 Main St",
            "city": "Springfield",
            "postal_code": "62704",
            "country": "USA",
            "website_url": "https://janedoe.com",
            "linkedin_url": "https://www.linkedin.com/in/janedoe",
        },
        "resume": {
            "executive_profile": {
                "baseline_text": "Senior engineer with 10+ years of experience."
            },
            "experience_entries": [
                {
                    "id": "acme_swe",
                    "date_range": "Jan 2020 -- Present",
                    "title": "Senior Software Engineer",
                    "company": "Acme Corp",
                    "location": "Remote",
                    "bullets": [
                        "Built a distributed system handling 1M requests/day.",
                        "Led migration from monolith to microservices.",
                    ],
                },
            ],
            "education_entries": [
                {
                    "id": "mit_cs",
                    "date": "Jun 2015",
                    "degree": "BS Computer Science",
                    "institution": "State University",
                    "location": "Cambridge, MA",
                },
            ],
            "skill_categories": [
                {
                    "id": "languages",
                    "label": "Languages",
                    "items": ["Python", "Go", "SQL"],
                },
            ],
            "tailoring_rules": {
                "required_experience_entry_ids": ["acme_swe"],
                "required_skill_category_ids": ["languages"],
                "max_experience_bullets": 4,
            },
        },
    }


@pytest.fixture
def minimal_tailoring_data():
    """Minimal LLM tailoring JSON output."""
    return {
        "executive_profile": "Experienced engineer specializing in distributed systems.",
        "experience_updates": [
            {
                "id": "acme_swe",
                "bullets": [
                    "Designed and deployed distributed services at scale.",
                    "Reduced latency by 40% through architecture improvements.",
                ],
            },
        ],
        "skill_category_updates": [
            {
                "id": "languages",
                "items": ["Python", "Go", "SQL"],
            },
        ],
    }


@pytest.fixture
def profile_with_special_chars(minimal_profile):
    """Profile with LaTeX-unsafe characters in metadata."""
    p = minimal_profile.copy()
    p["resume"] = {
        **minimal_profile["resume"],
        "experience_entries": [
            {
                    "id": "platform_lead",
                    "date_range": "Jul 2023 -- Mar 2024",
                    "title": "Platform Security & Cyber Defense Lead",
                    "company": "Northstar Labs",
                    "location": "Remote",
                "bullets": ["Managed 25+ FTEs across 4 global teams."],
            },
        ],
        "skill_categories": [
            {
                "id": "lang_core",
                "label": "Languages & Core Tech",
                "items": ["Python", "C++", "C#"],
            },
        ],
        "tailoring_rules": {
            "required_experience_entry_ids": ["dh_security"],
            "required_skill_category_ids": ["lang_core"],
        },
    }
    return p


# ── LaTeX Escaping ───────────────────────────────────────────────────────

class TestEscapeLatex:
    def test_ampersand(self):
        assert _escape_latex("R&D") == "R\\&D"

    def test_percent(self):
        assert _escape_latex("100%") == "100\\%"

    def test_hash(self):
        assert _escape_latex("#1") == "\\#1"

    def test_dollar(self):
        assert _escape_latex("$100") == "\\$100"

    def test_underscore(self):
        assert _escape_latex("my_var") == "my\\_var"

    def test_euro_sign(self):
        assert "\\texteuro" in _escape_latex("€500k")

    def test_em_dash(self):
        assert "---" in _escape_latex("word\u2014word")

    def test_en_dash(self):
        assert "--" in _escape_latex("2020\u20132024")

    def test_smart_quotes(self):
        result = _escape_latex("\u201cquoted\u201d")
        assert "``" in result and "''" in result


class TestEscapeLatexLight:
    def test_ampersand(self):
        assert _escape_latex_light("R&D") == "R\\&D"

    def test_percent(self):
        assert _escape_latex_light("100%") == "100\\%"

    def test_preserves_backslash_commands(self):
        # Light escaping should NOT mangle existing LaTeX commands
        assert "\\texteuro" in _escape_latex_light("\\texteuro 500")

    def test_euro_sign(self):
        assert "\\texteuro" in _escape_latex_light("€500k")


# ── pdflatex Discovery ───────────────────────────────────────────────────

class TestFindPdflatex:
    def test_finds_pdflatex(self):
        """pdflatex must be installed for these tests to pass."""
        path = _find_pdflatex()
        assert Path(path).exists()

    def test_env_override(self):
        with patch.dict("os.environ", {"PDFLATEX_PATH": "/usr/bin/true"}):
            assert _find_pdflatex() == "/usr/bin/true"

    def test_missing_raises(self):
        real_exists = Path.exists

        def fake_exists(path: Path) -> bool:
            if str(path) in {
                "/Library/TeX/texbin/pdflatex",
                "/usr/local/bin/pdflatex",
                "/opt/homebrew/bin/pdflatex",
            }:
                return False
            return real_exists(path)

        with patch("shutil.which", return_value=None), \
             patch.dict("os.environ", {}, clear=True), \
             patch("jobhunter.scoring.pdf.Path.exists", fake_exists):
            with pytest.raises(FileNotFoundError, match="pdflatex not found"):
                _find_pdflatex()


# ── LaTeX Generation ─────────────────────────────────────────────────────

class TestBuildLatex:
    def test_generates_valid_document(self, minimal_profile, minimal_tailoring_data):
        latex = build_latex(minimal_tailoring_data, minimal_profile)
        assert r"\documentclass" in latex
        assert r"\begin{document}" in latex
        assert r"\end{document}" in latex
        assert r"\makecvtitle" in latex

    def test_personal_data(self, minimal_profile, minimal_tailoring_data):
        latex = build_latex(minimal_tailoring_data, minimal_profile)
        assert r"\name{Jane}{Doe}" in latex
        assert r"\email{jane@example.com}" in latex
        assert r"\phone[mobile]{+1-555-0100}" in latex
        assert r"\homepage{janedoe.com}" in latex
        assert r"\social[linkedin]{janedoe}" in latex

    def test_executive_profile(self, minimal_profile, minimal_tailoring_data):
        latex = build_latex(minimal_tailoring_data, minimal_profile)
        assert "distributed systems" in latex

    def test_experience_bullets_from_llm(self, minimal_profile, minimal_tailoring_data):
        latex = build_latex(minimal_tailoring_data, minimal_profile)
        assert "Reduced latency by 40" in latex
        # Master bullets should NOT appear (LLM provided updates)
        assert "1M requests/day" not in latex

    def test_experience_falls_back_to_master(self, minimal_profile):
        """When LLM provides no update for an entry, master bullets are used."""
        data = {
            "executive_profile": "Test.",
            "experience_updates": [],
            "skill_category_updates": [{"id": "languages", "items": ["Python"]}],
        }
        latex = build_latex(data, minimal_profile)
        assert "1M requests/day" in latex

    def test_education(self, minimal_profile, minimal_tailoring_data):
        latex = build_latex(minimal_tailoring_data, minimal_profile)
        assert "BS Computer Science" in latex
        assert "State University" in latex

    def test_skills(self, minimal_profile, minimal_tailoring_data):
        latex = build_latex(minimal_tailoring_data, minimal_profile)
        assert "Python" in latex
        assert "Go" in latex

    def test_special_chars_in_metadata(self, profile_with_special_chars):
        """Ampersands and other special chars in profile metadata must be escaped."""
        data = {
            "executive_profile": "Test profile.",
            "experience_updates": [
                {"id": "platform_lead", "bullets": ["Managed global teams."]},
            ],
            "skill_category_updates": [
                {"id": "lang_core", "items": ["Python", "C++", "C#"]},
            ],
        }
        latex = build_latex(data, profile_with_special_chars)
        # Raw & must NOT appear in cventry or textbf
        assert "Security & Cyber" not in latex  # unescaped
        assert "Security \\& Cyber" in latex    # escaped
        assert "Languages \\& Core Tech" in latex

    def test_custom_template_text(self, minimal_profile, minimal_tailoring_data):
        template = (
            r"\documentclass{article}"
            "\n{{ personal_data }}"
            "\n\\begin{document}"
            "\nCUSTOM START"
            "\n{{ resume_body }}"
            "\nCUSTOM END"
            "\n\\end{document}"
        )
        latex = build_latex(minimal_tailoring_data, minimal_profile, template_text=template)

        assert "CUSTOM START" in latex
        assert "CUSTOM END" in latex
        assert r"\name{Jane}{Doe}" in latex
        assert "distributed systems" in latex

    def test_tailoring_policy_preserves_titles_and_required_bullets(self, minimal_profile, minimal_tailoring_data):
        minimal_tailoring_data["experience_updates"][0]["title"] = "Target Role Title"
        minimal_tailoring_data["experience_updates"][0]["bullets"] = ["New tailored bullet."]
        minimal_profile["resume"]["tailoring_rules"]["tailoring_policy"] = {
            "mode": "balanced",
            "allow_title_reframing": False,
            "allow_achievement_rewriting": True,
            "allow_skill_reordering": True,
            "allow_summary_rewrite": True,
            "allow_minor_inference": False,
        }
        minimal_profile["resume"]["tailoring_rules"]["required_bullets_by_experience_id"] = {
            "acme_swe": ["Built a distributed system handling 1M requests/day."]
        }

        latex = build_latex(minimal_tailoring_data, minimal_profile)

        assert "Senior Software Engineer" in latex
        assert "Target Role Title" not in latex
        assert "New tailored bullet." in latex
        assert "Built a distributed system handling 1M requests/day." in latex

    def test_strict_tailoring_policy_uses_baseline_content(self, minimal_profile, minimal_tailoring_data):
        minimal_profile["resume"]["tailoring_rules"]["tailoring_policy"] = {"mode": "strict"}

        latex = build_latex(minimal_tailoring_data, minimal_profile)

        assert "Senior engineer with 10+ years of experience." in latex
        assert "Experienced engineer specializing" not in latex
        assert "Built a distributed system handling 1M requests/day." in latex
        assert "Designed and deployed distributed services at scale." not in latex

    def test_default_template_is_valid(self):
        validate_latex_template(DEFAULT_RESUME_LATEX_TEMPLATE)

    def test_template_requires_resume_body_or_section_tokens(self):
        with pytest.raises(ValueError, match="resume_body"):
            validate_latex_template(r"\documentclass{article} {{ personal_data }}")


# ── PDF Compilation ──────────────────────────────────────────────────────

class TestRenderPdfLatex:
    def test_compiles_minimal_resume(self, minimal_profile, minimal_tailoring_data):
        """Full end-to-end: build LaTeX, compile to PDF."""
        latex = build_latex(minimal_tailoring_data, minimal_profile)
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            out = Path(f.name)
        try:
            render_pdf_latex(latex, str(out))
            assert out.exists()
            assert out.stat().st_size > 1000  # real PDF, not empty
            # Check it's actually a PDF
            assert out.read_bytes()[:5] == b"%PDF-"
        finally:
            out.unlink(missing_ok=True)

    def test_compiles_with_special_chars(self, profile_with_special_chars):
        """Profiles with & in titles/labels must compile without errors."""
        data = {
            "executive_profile": "Security leader with 10+ years experience.",
            "experience_updates": [
                {"id": "platform_lead", "bullets": ["Led 4 global security teams (25+ FTEs)."]},
            ],
            "skill_category_updates": [
                {"id": "lang_core", "items": ["Python", "C++"]},
            ],
        }
        latex = build_latex(data, profile_with_special_chars)
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            out = Path(f.name)
        try:
            render_pdf_latex(latex, str(out))
            assert out.exists()
            assert out.read_bytes()[:5] == b"%PDF-"
        finally:
            out.unlink(missing_ok=True)

    def test_invalid_latex_raises(self):
        """Broken LaTeX source must raise, not silently produce nothing."""
        bad_latex = r"\documentclass{article}\begin{document}\badcommand\end{document}"
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            out = Path(f.name)
        try:
            with pytest.raises(RuntimeError, match="pdflatex compilation failed"):
                render_pdf_latex(bad_latex, str(out))
        finally:
            out.unlink(missing_ok=True)


# ── Real Profile Test ────────────────────────────────────────────────────

class TestRealProfile:
    """Tests using the actual profile.json — skipped if not available."""

    @pytest.fixture
    def real_profile(self):
        try:
            from jobhunter.domain.tenant import LOCAL_TENANT
            from jobhunter.infrastructure.profile import build_profile_repository
            return build_profile_repository().load_snapshot(LOCAL_TENANT).as_dict()
        except Exception:
            pytest.skip("No profile.json available")

    def test_build_latex_with_real_profile(self, real_profile):
        from jobhunter.resume_profile import get_experience_entries, get_skill_categories
        data = {
            "executive_profile": "Test executive profile for validation.",
            "experience_updates": [
                {"id": e["id"], "bullets": e["bullets"][:2]}
                for e in get_experience_entries(real_profile)
            ],
            "skill_category_updates": [
                {"id": c["id"], "items": c["items"]}
                for c in get_skill_categories(real_profile)
            ],
        }
        latex = build_latex(data, real_profile)
        assert r"\begin{document}" in latex
        assert r"\end{document}" in latex

    def test_compile_with_real_profile(self, real_profile):
        from jobhunter.resume_profile import get_experience_entries, get_skill_categories
        data = {
            "executive_profile": "Test executive profile for compilation.",
            "experience_updates": [
                {"id": e["id"], "bullets": e["bullets"][:2]}
                for e in get_experience_entries(real_profile)
            ],
            "skill_category_updates": [
                {"id": c["id"], "items": c["items"]}
                for c in get_skill_categories(real_profile)
            ],
        }
        latex = build_latex(data, real_profile)
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            out = Path(f.name)
        try:
            render_pdf_latex(latex, str(out))
            assert out.exists()
            assert out.stat().st_size > 1000
            assert out.read_bytes()[:5] == b"%PDF-"
        finally:
            out.unlink(missing_ok=True)
