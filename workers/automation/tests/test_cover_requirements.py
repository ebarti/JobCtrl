import pytest

from jobctrl.scoring.cover_letter import _get_resume_text_for_job


def test_cover_generation_requires_tailored_resume():
    with pytest.raises(FileNotFoundError, match="requires a tailored resume"):
        _get_resume_text_for_job({"tailored_resume_path": None}, "base resume")
