"""Content-safe errors shared by transport adapters."""

from __future__ import annotations


class AppError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details

    def payload(self) -> dict:
        value: dict = {"code": self.code, "message": self.message}
        if self.details is not None:
            value["details"] = self.details
        return {"error": value}


class ConflictError(AppError):
    def __init__(self, message: str = "The saved version has changed.", **details):
        super().__init__("revision_conflict", message, 409, details or None)


class NotFoundError(AppError):
    def __init__(self, message: str = "The requested record does not exist."):
        super().__init__("not_found", message, 404)
