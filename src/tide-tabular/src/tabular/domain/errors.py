"""Domain-level failures. Framework-free: the API layer maps these to HTTP.

Each error carries a stable `code` and whether retry is safe to automate.
The caller (CAP's queue) honors the explicit `retryable` flag.
"""

from __future__ import annotations


class TabularError(Exception):
    """Base for every error raised from the domain/application layers."""

    code = "INTERNAL"
    retryable = False


class ValidationFailure(TabularError):
    """The request is malformed or violates a configured limit."""

    code = "VALIDATION"


class ClassLimit(ValidationFailure):
    """More classes than the backend supports; CAP caps classes before sending."""

    code = "CLASS_LIMIT"


class UnsupportedCapability(ValidationFailure):
    code = "UNSUPPORTED_CAPABILITY"


class ModelReferenceInvalid(ValidationFailure):
    code = "MODEL_REFERENCE_INVALID"


class LimitExceeded(TabularError):
    """The request is larger than a configured limit (rows, columns, cells, bytes)."""

    code = "LIMIT_EXCEEDED"


class ConfigurationError(TabularError):
    """The service is not configured for the requested backend."""

    code = "NOT_CONFIGURED"


class Overloaded(TabularError):
    """All backend slots are busy; retry after `retry_after_s`."""

    code = "OVERLOADED"
    retryable = True

    def __init__(self, message: str, retry_after_s: int = 5) -> None:
        super().__init__(message)
        self.retry_after_s = retry_after_s


class UpstreamError(TabularError):
    """The tabular backend returned an error or was unreachable."""

    code = "UPSTREAM_ERROR"
    retryable = True


class UpstreamRejected(TabularError):
    """The backend rejected the request itself (4xx); retrying won't help."""

    code = "UPSTREAM_REJECTED"


class MalformedUpstream(UpstreamError):
    """Provider output violates the prediction contract; do not replay paid work."""

    code = "UPSTREAM_MALFORMED"
    retryable = False


class UpstreamTimeout(TabularError):
    """The backend call exceeded the caller's deadline."""

    code = "UPSTREAM_TIMEOUT"
    retryable = True


class OutcomeUnknown(UpstreamTimeout):
    """Inference may still be running or billed; automatic replay is unsafe."""

    code = "UPSTREAM_OUTCOME_UNKNOWN"
    retryable = False
