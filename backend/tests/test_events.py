from __future__ import annotations

import asyncio
import json

from app.services.events import EventHub, REDIS_CHANNEL_PREFIX


class FakeWebSocket:
    def __init__(self) -> None:
        self.events = []
        self.subprotocol = None

    async def accept(self, subprotocol=None) -> None:
        self.subprotocol = subprotocol

    async def send_json(self, event) -> None:
        self.events.append(event)


class FakeRedis:
    def __init__(self) -> None:
        self.published = []

    async def publish(self, channel: str, payload: str) -> None:
        self.published.append((channel, json.loads(payload)))


class FailingRedis:
    async def publish(self, _channel: str, _payload: str) -> None:
        raise ConnectionError("redis unavailable")


class FailingWebSocket(FakeWebSocket):
    async def send_json(self, _event) -> None:
        raise ConnectionError("socket closed")


def test_event_hub_delivers_locally_without_redis() -> None:
    async def run() -> None:
        hub = EventHub()
        socket = FakeWebSocket()
        await hub.connect("store:store-001", socket)
        event = {"event": "transcript.final", "storeId": "store-001"}
        await hub.publish("store:store-001", event)
        assert socket.events == [event]
        assert socket.subprotocol is None

    asyncio.run(run())


def test_event_hub_falls_back_to_local_delivery_when_redis_publish_fails() -> None:
    async def run() -> None:
        hub = EventHub()
        socket = FakeWebSocket()
        await hub.connect("store:store-001", socket)
        hub._redis = FailingRedis()
        event = {"event": "transcript.final", "storeId": "store-001"}
        await hub.publish("store:store-001", event)
        assert socket.events == [event]

    asyncio.run(run())


def test_event_hub_publishes_to_redis_and_fans_out_received_events() -> None:
    async def run() -> None:
        hub = EventHub()
        socket = FakeWebSocket()
        await hub.connect("store:store-001", socket)
        redis = FakeRedis()
        hub._redis = redis
        event = {"event": "device.health.updated", "storeId": "store-001"}

        await hub.publish("store:store-001", event)
        assert redis.published == [(f"{REDIS_CHANNEL_PREFIX}store:store-001", event)]
        assert socket.events == []

        await hub._on_redis_message({
            "channel": f"{REDIS_CHANNEL_PREFIX}store:store-001",
            "data": json.dumps(event),
        })
        assert socket.events == [event]

    asyncio.run(run())


def test_event_hub_removes_stale_sockets_from_their_actual_room() -> None:
    async def run() -> None:
        hub = EventHub()
        stale = FailingWebSocket()
        await hub.connect("dashboard", stale)
        await hub.publish("store:store-001", {"event": "store.connected"})
        assert stale not in hub._rooms["dashboard"]

    asyncio.run(run())