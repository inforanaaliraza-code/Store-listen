from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
import time
from pathlib import Path
from urllib import request

logging.basicConfig(level=logging.INFO, format="%(asctime)s store-agent %(message)s")
log = logging.getLogger("store-agent")
RUNNING = True


def shutdown(*_args) -> None:
    global RUNNING
    RUNNING = False


def post_json(url: str, payload: dict, token: str | None = None) -> dict:
    data = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = request.Request(url, data=data, headers=headers, method="POST")
    with request.urlopen(req, timeout=8) as resp:
        return json.loads(resp.read().decode())


def heartbeat_loop(api_base: str, device_id: str, token: str, backoff: float = 1.0) -> None:
    while RUNNING:
        try:
            req = request.Request(
                f"{api_base}/health",
                headers={"Authorization": f"Bearer {token}"} if token else {},
            )
            with request.urlopen(req, timeout=5) as resp:
                status = resp.status
            log.info("heartbeat device=%s api=%s", device_id, status)
            backoff = 1.0
        except Exception as exc:
            log.warning("heartbeat failed (%s); retry in %.1ss", exc, backoff)
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)
            continue
        time.sleep(5)


def main() -> None:
    parser = argparse.ArgumentParser(description="Store Listen edge agent")
    parser.add_argument("--api", default="http://localhost:8000")
    parser.add_argument("--device-id", default="device-001")
    parser.add_argument("--token", default="")
    parser.add_argument("--audio-source", default="mock", choices=["mock", "file", "microphone"])
    args = parser.parse_args()
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    log.info("starting store agent device=%s source=%s (no master API keys embedded)", args.device_id, args.audio_source)
    config_path = Path.home() / ".storelisten" / "device.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    if not config_path.exists():
        config_path.write_text(json.dumps({"device_id": args.device_id, "audio_source": args.audio_source}, indent=2))
    heartbeat_loop(args.api, args.device_id, args.token)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
