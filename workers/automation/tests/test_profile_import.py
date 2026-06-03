from jobhunter.discovery.target_queries import build_target_role_queries
from jobhunter.profile_import import PdfTextResult, extract_pdf_text, profile_from_resume_text, style_from_pdf_metadata


def _simple_pdf(lines: list[str]) -> bytes:
    text_ops = []
    for line in lines:
        escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        text_ops.append(f"({escaped}) Tj T*")
    content = "BT /F1 11 Tf 72 720 Td 14 TL\n" + "\n".join(text_ops) + "\nET\n"
    objects = [
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
        (
            "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n"
        ),
        "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
        f"5 0 obj << /Length {len(content.encode('latin-1'))} >> stream\n{content}endstream endobj\n",
    ]
    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for obj in objects:
        offsets.append(len(output))
        output.extend(obj.encode("latin-1"))
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode("latin-1"))
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("latin-1"))
    output.extend(f"trailer << /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("latin-1"))
    return bytes(output)


def test_extract_pdf_text_reads_resume_pdf_text_and_metadata():
    result = extract_pdf_text(
        _simple_pdf(["Alex Rivera", "alex@example.com", "Executive Profile", "Platform engineer."])
    )

    assert result.page_count == 1
    assert "Alex Rivera" in result.text
    assert "alex@example.com" in result.text
    assert result.page_sizes == [(612.0, 792.0)]
    assert "/Helvetica" in result.font_names


def test_profile_from_resume_text_builds_structured_profile_and_preserves_application_defaults():
    text = """
    Alex Rivera
    alex@example.com | +1 415 555 0101 | https://www.linkedin.com/in/alexrivera | https://github.com/alexrivera

    Executive Profile
    Platform engineer with 8 years of experience building reliable APIs and cloud infrastructure.

    Experience
    Senior Platform Engineer, Acme Cloud
    Jan 2021 -- Present
    - Built Python services processing 2M events per day.
    - Reduced deployment failures by 35% through release automation.

    Platform Engineer at Sample Systems
    Jun 2018 -- Dec 2020
    - Migrated batch jobs to Kubernetes for 20 teams.

    Education
    Master of Science in Computer Science
    State University
    2018

    Skills
    Languages: Python, Go, SQL
    Platform: Kubernetes, AWS, Terraform
    """
    base = {
        "work_authorization": {"legally_authorized_to_work": "Yes"},
        "compensation": {"salary_currency": "USD"},
        "resume": {
            "tailoring_rules": {
                "tailoring_policy": {"mode": "strict"},
                "writing_style": {"tone": "technical"},
                "custom_tailoring_prompt": "Keep platform impact visible.",
            }
        },
    }

    profile = profile_from_resume_text(text, base_profile=base)

    assert profile["personal"]["full_name"] == "Alex Rivera"
    assert profile["personal"]["email"] == "alex@example.com"
    assert profile["personal"]["github_url"] == "https://github.com/alexrivera"
    assert profile["work_authorization"]["legally_authorized_to_work"] == "Yes"
    assert profile["compensation"]["salary_currency"] == "USD"
    assert profile["resume"]["executive_profile"]["baseline_text"].startswith("Platform engineer")
    assert profile["resume"]["experience_entries"][0]["title"] == "Senior Platform Engineer"
    assert profile["resume"]["experience_entries"][0]["company"] == "Acme Cloud"
    assert profile["resume"]["experience_entries"][0]["bullets"] == [
        "Built Python services processing 2M events per day.",
        "Reduced deployment failures by 35% through release automation.",
    ]
    assert profile["resume"]["education_entries"][0]["degree"] == "Master of Science in Computer Science"
    assert profile["resume"]["skill_categories"][0]["items"] == ["Python", "Go", "SQL"]
    assert profile["experience"]["target_track"] == "IC"
    assert profile["experience"]["target_seniority_floor"] == "Senior"
    assert "Platform" in profile["experience"]["target_functions"]
    assert "Backend" in profile["experience"]["target_functions"]
    rules = profile["resume"]["tailoring_rules"]
    assert rules["required_experience_entry_ids"] == [
        "acme_cloud_senior_platform_engineer",
        "sample_systems_platform_engineer",
    ]
    assert rules["required_education_entry_ids"] == ["state_university_master_of_science_in_computer_science_2018"]
    assert rules["required_bullets_by_experience_id"] == {}
    assert rules["tailoring_policy"]["mode"] == "strict"
    assert rules["tailoring_policy"]["claim_mode"] == "verified_only"
    assert rules["tailoring_policy"]["auto_approvable_claim_modes"] == ["verified_only"]
    assert rules["tailoring_policy"]["allow_adjacent_achievement_drafts"] is False
    assert rules["writing_style"]["tone"] == "technical"
    assert rules["custom_tailoring_prompt"] == "Keep platform impact visible."
    assert profile["resume_constraints"]["real_metrics"] == ["2M events", "35%", "20 teams"]


def test_profile_import_keeps_existing_target_search_guidance():
    text = """
    Jordan Candidate

    Experience
    Senior Platform Engineer, Acme Cloud
    Jan 2021 -- Present
    - Built APIs for SaaS infrastructure.
    """
    base = {
        "experience": {
            "target_role": "Principal Platform Engineer",
            "target_track": "Management",
            "target_seniority_floor": "Director",
            "target_functions": "Security",
            "target_specializations": "Robotics",
        }
    }

    profile = profile_from_resume_text(text, base_profile=base)

    assert profile["experience"]["target_role"] == "Principal Platform Engineer"
    assert profile["experience"]["target_track"] == "Management"
    assert profile["experience"]["target_seniority_floor"] == "Director"
    assert profile["experience"]["target_functions"] == "Security"
    assert profile["experience"]["target_specializations"] == "Robotics"


def test_profile_import_abbreviation_executive_title_plans_chief_level_queries():
    text = """
    Jordan Candidate

    Experience
    CTO, Acme Cloud
    Jan 2021 -- Present
    - Led technology strategy and platform engineering.
    """

    profile = profile_from_resume_text(text)

    assert profile["experience"]["target_track"] == "Executive"
    assert profile["experience"]["target_seniority_floor"] == "C-level"
    queries = build_target_role_queries(
        [],
        tracks=[profile["experience"]["target_track"]],
        seniority=[profile["experience"]["target_seniority_floor"]],
        functions=profile["experience"]["target_functions"].split("; "),
    )
    query_texts = [item["query"] for item in queries]
    assert "CTO" in query_texts
    assert "Chief Technology Officer" in query_texts
    assert not any("Director" in query or "Head of" in query or query.startswith("VP ") for query in query_texts)


def test_style_from_pdf_metadata_infers_editable_style_controls():
    result = PdfTextResult(
        text="Resume text",
        page_count=1,
        page_sizes=[(612.0, 792.0)],
        font_names=["/TimesNewRomanPSMT"],
        font_sizes=[10.0, 10.5, 11.0],
    )

    style = style_from_pdf_metadata(result, base_style={"moderncv_color": "blue"})

    assert style["paper_size"] == "letterpaper"
    assert style["document_font_size"] == "11pt"
    assert style["font_family"] == "roman"
    assert style["body_alignment"] == "left"
    assert style["moderncv_color"] == "blue"
