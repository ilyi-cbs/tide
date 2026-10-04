from __future__ import annotations

import threading


class AdmissionLimiter:
    def __init__(self, capacity: int) -> None:
        self._slots = threading.BoundedSemaphore(capacity)

    def acquire(self, blocking: bool = False) -> bool:
        return self._slots.acquire(blocking=blocking)

    def release(self) -> None:
        self._slots.release()
