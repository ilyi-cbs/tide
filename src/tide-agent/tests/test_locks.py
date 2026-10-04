"""Unit tests for the per-thread pending-input guard: a second
request on a busy thread is rejected, not queued."""

from __future__ import annotations

import asyncio

import pytest

from agent.app.locks import ThreadBusyError, ThreadLocks


async def test_sequential_acquire_on_same_thread_succeeds():
    locks = ThreadLocks()

    async with locks.acquire("t1"):
        pass
    async with locks.acquire("t1"):
        pass


async def test_concurrent_acquire_on_same_thread_raises_busy():
    locks = ThreadLocks()
    entered = asyncio.Event()
    release = asyncio.Event()

    async def hold() -> None:
        async with locks.acquire("t1"):
            entered.set()
            await release.wait()

    task = asyncio.create_task(hold())
    await entered.wait()
    try:
        with pytest.raises(ThreadBusyError):
            async with locks.acquire("t1"):
                pass
    finally:
        release.set()
        await task


async def test_different_threads_do_not_contend():
    locks = ThreadLocks()
    entered = asyncio.Event()
    release = asyncio.Event()

    async def hold() -> None:
        async with locks.acquire("t1"):
            entered.set()
            await release.wait()

    task = asyncio.create_task(hold())
    await entered.wait()
    try:
        async with locks.acquire("t2"):
            pass
    finally:
        release.set()
        await task


async def test_idle_thread_locks_are_released():
    locks = ThreadLocks()
    for index in range(1000):
        async with locks.acquire(f"thread-{index}"):
            assert len(locks._locks) == 1
    assert not locks._locks
