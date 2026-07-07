"""Owned email-application sender for guarded apply runs."""

from __future__ import annotations

from jobctrl.domain.ports.apply import EmailApplicationCandidate, EmailApplicationSendResult
from jobctrl.infrastructure.gmail.client import GmailClient


class GmailEmailApplicationSender:
    """Send approved email applications through the first-party Gmail client."""

    def __init__(self, *, client: GmailClient | None = None) -> None:
        self._client = client or GmailClient()

    def send_email_application(self, candidate: EmailApplicationCandidate) -> EmailApplicationSendResult:
        result = self._client.send_email_application(
            to_email=candidate.recipient_email,
            subject=candidate.subject,
            body=candidate.body,
            attachment_path=candidate.attachment_path,
            attachment_name=candidate.attachment_name,
        )
        return EmailApplicationSendResult(
            provider="gmail",
            message_id=str(result.get("id") or ""),
            thread_id=str(result.get("threadId") or ""),
        )
