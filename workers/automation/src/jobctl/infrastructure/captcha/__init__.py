"""Owned CAPTCHA solver integrations for guarded apply runs."""

from .capsolver import (
    CaptchaChallenge,
    CaptchaSolveError,
    CaptchaSolveResult,
    solve_with_capsolver,
)

__all__ = [
    "CaptchaChallenge",
    "CaptchaSolveError",
    "CaptchaSolveResult",
    "solve_with_capsolver",
]
