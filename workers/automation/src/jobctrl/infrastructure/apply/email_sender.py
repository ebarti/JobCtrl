"""Owned email-application sender for guarded apply runs."""

from __future__ import annotations

from jobctrl.domain.ports.apply import EmailApplicationCandidate, EmailApplicationOperation, EmailApplicationSendResult
from jobctrl.infrastructure.gmail.client import GmailClient, validate_send_confirmation


class GmailEmailApplicationSender:
    """Send approved email applications through the first-party Gmail client."""

    def __init__(self, *, client: GmailClient | None = None) -> None:
        self._client = client or GmailClient()

    def send_email_application(self, candidate: EmailApplicationCandidate, *, operation: EmailApplicationOperation) -> EmailApplicationSendResult:
        if not isinstance(candidate.attachment_bytes, bytes) or not candidate.attachment_bytes:
            raise ValueError("Email attachment bytes were not authorized")
        if type(operation) is not EmailApplicationOperation or operation.candidate_fingerprint != candidate.fingerprint():
            raise ValueError("email_candidate_binding_mismatch")
        result = self._client.send_email_application(
            to_email=candidate.recipient_email,
            subject=candidate.subject,
            body=candidate.body,
            attachment_bytes=candidate.attachment_bytes,
            attachment_name=candidate.attachment_name,
        )
        result = validate_send_confirmation(result)
        return EmailApplicationSendResult(
            provider="gmail",
            message_id=result["id"],
            thread_id=result.get("threadId"),
            operation=operation,
        )
