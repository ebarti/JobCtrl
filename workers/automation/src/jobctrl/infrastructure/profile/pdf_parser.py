"""PDF format extraction followed by a cited model extraction determination."""

from jobctrl.profile_import import import_resume_pdf
from jobctrl.domain.profile.resume_extraction import ModelResumeExtractor
from jobctrl.infrastructure.profile.import_attempt import record_import_attempt


class PyPdfProfileParser:
    def __init__(self, *, connection, dependencies):
        self._connection = connection
        self._dependencies = dependencies
        self._extractor = ModelResumeExtractor(**dependencies)

    def parse(self, pdf_bytes, *, filename, base_profile, base_style, attempt_id=None):
        draft = import_resume_pdf(
            pdf_bytes, filename=filename, base_profile=base_profile, base_style=base_style, extractor=self._extractor
        )
        if attempt_id is not None:
            record_import_attempt(self._connection, self._dependencies["tenant_id"], attempt_id, pdf_bytes, draft)
            draft["source"]["attemptId"] = attempt_id
        from jobctrl.domain.profile.interpretation import ModelCandidateInterpreter

        result, envelope = ModelCandidateInterpreter(**self._dependencies).interpret(
            profile=draft["profile"], profile_version="draft", entity_id="resume-import"
        )
        draft["source"].update(
            candidateDeterminationId=envelope.determination_id, candidateInterpretation=result.model_dump()
        )
        return draft
