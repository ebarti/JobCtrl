"""PDF format extraction followed by a cited model extraction determination."""

from jobctrl.profile_import import import_resume_pdf
from jobctrl.domain.profile.resume_extraction import ModelResumeExtractor


class PyPdfProfileParser:
    def __init__(self, *, dependencies):
        self._dependencies = dependencies
        self._extractor = ModelResumeExtractor(**dependencies)

    def parse(self, pdf_bytes, *, filename, base_profile, base_style):
        draft = import_resume_pdf(
            pdf_bytes, filename=filename, base_profile=base_profile, base_style=base_style, extractor=self._extractor
        )
        from jobctrl.domain.profile.interpretation import ModelCandidateInterpreter

        result, envelope = ModelCandidateInterpreter(**self._dependencies).interpret(
            profile=draft["profile"], profile_version="draft", entity_id="resume-import"
        )
        draft["source"].update(
            candidateDeterminationId=envelope.determination_id, candidateInterpretation=result.model_dump()
        )
        return draft
