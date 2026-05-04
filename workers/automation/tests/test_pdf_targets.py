from pathlib import Path

from jobhunter.database import close_connection, get_connection, init_db
from jobhunter.scoring.pdf import get_pending_conversion_targets


def test_pending_pdf_targets_only_include_db_cover_letters(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    cover = Path(tmp_path) / "cover_letter.txt"
    stray_resume = Path(tmp_path) / "tailored_resume.txt"
    cover.write_text("cover", encoding="utf-8")
    stray_resume.write_text("resume", encoding="utf-8")

    conn.execute(
        """
        INSERT INTO jobs (
            url, title, site, full_description, application_url,
            fit_score, tailored_resume_path, cover_letter_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "https://example.com/job",
            "Platform Engineer",
            "ExampleCo",
            "Build APIs.",
            "https://example.com/apply",
            9,
            str(stray_resume),
            str(cover),
        ),
    )
    conn.commit()

    try:
        monkeypatch.setattr("jobhunter.scoring.pdf.get_connection", lambda: get_connection(db_path))

        targets = get_pending_conversion_targets()

        assert targets == [cover]
        assert stray_resume not in targets
    finally:
        close_connection(db_path)
