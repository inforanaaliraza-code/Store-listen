from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from typing import Any

from fastapi import WebSocket
from redis.asyncio import Redis

logger = logging.getLogger("storelisten.events")
REDIS_CHANNEL_PREFIX = "store-listen:events:"


class EventHub:
    def __init__(self) -> None:
        self._rooms: dict[str, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()
        self._redis: Redis | None = None
        self._pubsub = None
        self._listener: asyncio.Task | None = None

    @property
    def distributed(self) -> bool:
        return self._redis is not None

    async def start(self, redis_url: str, *, enabled: bool, required: bool = False) -> None:
        if not enabled and not required:
            return
        client = Redis.from_url(redis_url, decode_responses=True, socket_connect_timeout=3)
        try:
            await client.ping()
            pubsub = client.pubsub()
            await pubsub.psubscribe(**{f"{REDIS_CHANNEL_PREFIX}*": self._on_redis_message})
        except Exception:
            await client.aclose()
            if required:
                raise RuntimeError("Redis event bus is required but unavailable. Check REDIS_URL and network access.") from None
            logger.warning("Redis event bus unavailable; using single-process WebSocket delivery", exc_info=True)
            return
        self._redis = client
        self._pubsub = pubsub
        self._listener = asyncio.create_task(pubsub.run(exception_handler=self._on_redis_error, poll_timeout=1))

    async def _on_redis_error(self, error: Exception, _pubsub, _message) -> None:
        logger.warning("Redis event listener error: %s", type(error).__name__)

    async def _on_redis_message(self, message: dict[str, Any]) -> None:
        channel = str(message.get("channel", ""))
        if not channel.startswith(REDIS_CHANNEL_PREFIX):
            return
        try:
            event = json.loads(message["data"])
        except (KeyError, TypeError, json.JSONDecodeError):
            logger.warning("Discarding invalid Redis event payload")
            return
        await self._deliver_local(channel.removeprefix(REDIS_CHANNEL_PREFIX), event)

    async def stop(self) -> None:
        if self._listener:
            self._listener.cancel()
            try:
                await self._listener
            except asyncio.CancelledError:
                pass
            self._listener = None
        if self._pubsub:
            await self._pubsub.aclose()
            self._pubsub = None
        if self._redis:
            await self._redis.aclose()
            self._redis = None

    async def connect(self, room: str, websocket: WebSocket, subprotocol: str | None = None) -> None:
        await websocket.accept(subprotocol=subprotocol)
        async with self._lock:
            self._rooms[room].add(websocket)

    async def disconnect(self, room: str, websocket: WebSocket) -> None:
        async with self._lock:
            self._rooms[room].discard(websocket)

    async def publish(self, room: str, event: dict[str, Any]) -> None:
        if self._redis:
            try:
                await self._redis.publish(f"{REDIS_CHANNEL_PREFIX}{room}", json.dumps(event, separators=(",", ":")))
                return
            except Exception as error:
                logger.warning("Redis publish failed; delivering event to local sockets (%s)", type(error).__name__)
        await self._deliver_local(room, event)

    async def _deliver_local(self, room: str, event: dict[str, Any]) -> None:
        async with self._lock:
            deliveries = [(room, socket) for socket in self._rooms.get(room, set())]
            deliveries.extend(("dashboard", socket) for socket in self._rooms.get("dashboard", set()) if socket not in self._rooms.get(room, set()))
        stale: list[tuple[str, WebSocket]] = []
        for room_name, socket in deliveries:
            try:
                await socket.send_json(event)
            except Exception:
                stale.append((room_name, socket))
        for room_name, socket in stale:
            await self.disconnect(room_name, socket)


hub = EventHub()
