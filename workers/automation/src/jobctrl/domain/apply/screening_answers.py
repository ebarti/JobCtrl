"""Application-bound screening lifecycle; never an Apply authorization."""

from copy import deepcopy
from typing import Literal
from uuid import uuid4

from pydantic import Field, StrictInt, StrictStr

from jobctrl.domain.determinations import DeterminationFailure, DeterminationModel, Source


class ScreeningCommand(DeterminationModel):
    action: Literal["capture", "draft", "edit", "review", "reuse", "use"]
    idempotencyKey: StrictStr = Field(min_length=1, max_length=160)
    expectedRevision: StrictInt = Field(ge=0)
    questionId: StrictStr | None = Field(default=None, min_length=1, max_length=160)
    applicationId: StrictStr | None = Field(default=None, min_length=1, max_length=160)
    question: StrictStr | None = Field(default=None, min_length=1, max_length=4000)
    context: StrictStr | None = Field(default=None, min_length=1, max_length=4000)
    selectedFactIds: list[StrictStr] = Field(default_factory=list, max_length=100)
    sensitiveFactIds: list[StrictStr] = Field(default_factory=list, max_length=100)
    text: StrictStr | None = Field(default=None, min_length=1, max_length=16000)
    decision: Literal["approved", "rejected"] | None = None
    libraryId: StrictStr | None = Field(default=None, min_length=1, max_length=160)
    attested: bool = False


class ScreeningAnswerService:
    def __init__(self, repository, generator):
        self.repository, self.generator = repository, generator

    def execute(self, tenant, job, command: ScreeningCommand):
        try:
            return self._execute(tenant, job, command)
        except DeterminationFailure as failure:
            self.repository.record_failure(tenant, job, command, failure.code)
            raise

    def _execute(self, tenant, job, command):
        repo = self.repository
        repeated = repo.repeated(tenant, job, command)
        if repeated is not None:
            return repeated
        current = repo.current(tenant, command.questionId) if command.questionId else None
        if command.action == "capture":
            if not command.question or not command.context or not command.applicationId:
                raise DeterminationFailure("screening_missing_context")
            if current and (current["jobId"] != job or current["applicationId"] != command.applicationId):
                raise DeterminationFailure("screening_foreign_context")
            state = (
                deepcopy(current)
                if current
                else {
                    "questionId": command.questionId or uuid4().hex,
                    "jobId": job,
                    "applicationId": command.applicationId,
                    "revision": 0,
                    "draft": None,
                    "accepted": None,
                }
            )
            state.update(question=command.question, context=command.context, draft=None)
            binding, _ = repo.sources(tenant, job, [], [])
            state["captureBinding"] = binding
        else:
            if current is None or current["jobId"] != job:
                raise DeterminationFailure("screening_not_found")
            state = deepcopy(current)
        if state["revision"] != command.expectedRevision:
            raise DeterminationFailure("screening_revision_conflict")
        library = None
        if command.action in {"draft", "edit", "reuse"}:
            binding, selected = repo.sources(tenant, job, command.selectedFactIds, command.sensitiveFactIds)
            binding.update(question=state["question"], context=state["context"], applicationId=state["applicationId"])
            prior = None
            if command.action == "reuse":
                library = repo.library_entry(tenant, command.libraryId)
                if library is None:
                    raise DeterminationFailure("screening_library_not_found")
                prior = library["answer"]
                # Exact facts/consent may be checked structurally; meaning always uses the model.
                if prior["binding"]["facts"] != binding["facts"]:
                    raise DeterminationFailure("screening_facts_changed")
                if prior["binding"]["sensitiveFactIds"] != binding["sensitiveFactIds"]:
                    raise DeterminationFailure("screening_sensitive_selection_changed")
            if command.action == "edit" and not command.text:
                raise DeterminationFailure("screening_missing_text")

            def source_fence():
                repo.assert_sources(tenant, job, binding)
                latest = repo.current(tenant, state["questionId"])
                if latest is None or latest["revision"] != command.expectedRevision:
                    raise DeterminationFailure("screening_revision_conflict")

            prepared = self.generator.prepare(
                entity_id=state["questionId"],
                question=state["question"],
                context=repo.model_context(binding),
                facts=[Source(source_id=f["id"], text=f["text"]) for f in selected],
                binding=binding,
                source_fence=source_fence,
                edited_text=command.text if command.action == "edit" else None,
                prior=prior,
            )
            repo.assert_sources(tenant, job, binding)
            state["selection"] = {
                "factIds": sorted(command.selectedFactIds),
                "sensitiveFactIds": sorted(command.sensitiveFactIds),
            }
            state["draft"] = {
                **prepared,
                "answerId": uuid4().hex,
                "binding": binding,
                "question": state["question"],
                "context": repo.model_context(binding),
                "libraryId": library["libraryId"] if library else None,
            }
        elif command.action == "review":
            if command.decision is None or state["draft"] is None:
                raise DeterminationFailure("screening_missing_draft")
            if command.decision == "approved":
                repo.assert_answer(tenant, job, state, state["draft"])
                state["accepted"] = deepcopy(state["draft"])
                state["accepted"]["reviewId"] = uuid4().hex
                library = {
                    "libraryId": uuid4().hex,
                    "answer": state["accepted"],
                    "questionId": state["questionId"],
                    "jobId": job,
                    "applicationId": state["applicationId"],
                }
            state["decision"] = command.decision
        elif command.action == "use":
            if not command.attested or not command.text or state["accepted"] is None:
                raise DeterminationFailure("screening_attestation_required")
            repo.assert_answer(tenant, job, state, state["accepted"])
            state["manualUse"] = {
                "useId": uuid4().hex,
                "reviewId": state["accepted"]["reviewId"],
                "answerId": state["accepted"]["answerId"],
                "text": command.text,
                "attested": True,
                "changed": command.text != state["accepted"]["text"],
            }
        state["revision"] += 1
        state["action"] = command.action
        state["snapshotId"] = uuid4().hex
        return repo.save(
            tenant,
            job,
            command,
            state,
            library if command.action == "review" and command.decision == "approved" else None,
        )
