from __future__ import annotations

import logging
import re
import time
import uuid
from contextlib import asynccontextmanager
from collections import defaultdict, deque

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import api, health
from app.config import settings
from app.database import SessionLocal, check_database_connection
from app.seed import seed_if_empty
from app.services.audio_storage import cleanup_expired_audio
from app.services.events import hub

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("storelisten")


@asynccontextmanager
async def lifespan(_: FastAPI):
    production = settings.app_env.lower() == "production"
    await hub.start(
        settings.redis_url,
        enabled=settings.redis_event_bus_enabled,
        required=production,
    )
    try:
        if production:
            check_database_connection()
        else:
            check_database_connection()
        with SessionLocal() as db:
            if settings.demo_mode:
                seed_if_empty(db)
            cleanup_expired_audio(db)
        logger.info("Store Listen API ready demo_mode=%s db=mongodb", settings.demo_mode)
        yield
    finally:
        await hub.stop()

app = FastAPI(title="Store Listen API", version="1.0.0", docs_url="/docs", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_origin_regex=settings.cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID", "Retry-After"],
)
app.include_router(health)
app.include_router(api)

_hits: dict[str, deque[float]] = defaultdict(deque)
_last_rate_limit_prune = 0.0


def _secure_response(response: Response, request_id: str) -> Response:
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "microphone=(self), camera=(), geolocation=()"
    return response


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, error: RequestValidationError) -> JSONResponse:
    issues = [
        {
            "field": ".".join(str(part) for part in issue.get("loc", ()) if part != "body"),
            "message": issue.get("msg", "Invalid value"),
            "type": issue.get("type", "value_error"),
        }
        for issue in error.errors()[:20]
    ]
    message = "; ".join(f"{issue['field']}: {issue['message']}" if issue["field"] else issue["message"] for issue in issues)
    return JSONResponse(
        {"detail": message or "Request validation failed", "errors": issues, "request_id": request.state.request_id},
        status_code=422,
    )


@app.middleware("http")
async def security_and_limits(request: Request, call_next):
    supplied_request_id = request.headers.get("x-request-id", "")
    request_id = supplied_request_id if re.fullmatch(r"[A-Za-z0-9._-]{1,128}", supplied_request_id) else str(uuid.uuid4())
    request.state.request_id = request_id
    client = request.client.host if request.client else "unknown"
    now = time.time()
    global _last_rate_limit_prune
    if now - _last_rate_limit_prune > 60:
        cutoff = now - 60
        for address, requests in list(_hits.items()):
            while requests and cutoff - requests[0] > 0:
                requests.popleft()
            if not requests:
                _hits.pop(address, None)
        _last_rate_limit_prune = now
    bucket = _hits[client]
    while bucket and now - bucket[0] > 60:
        bucket.popleft()
    if len(bucket) >= settings.rate_limit_per_minute:
        retry_after = max(1, int(60 - (now - bucket[0]))) if bucket else 60
        response = JSONResponse(
            {"detail": f"Rate limit exceeded. Retry in {retry_after} seconds.", "request_id": request_id},
            status_code=429,
            headers={"Retry-After": str(retry_after)},
        )
        return _secure_response(response, request_id)
    bucket.append(now)
    try:
        response = await call_next(request)
    except Exception:
        logger.exception("Unhandled error rid=%s", request_id)
        response = JSONResponse({"detail": "Internal error", "request_id": request_id}, status_code=500)
    return _secure_response(response, request_id)


