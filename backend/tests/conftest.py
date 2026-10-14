import pytest

from app.config import settings
from app.database import SessionLocal, check_database_connection
from app.main import _hits
from app.seed import seed_if_empty


@pytest.fixture(autouse=True)
def initialize_test_database():
    if settings.app_env.lower() == "test":
        check_database_connection()
        with SessionLocal() as db:
            seed_if_empty(db)
    yield


@pytest.fixture(autouse=True)
def isolate_rate_limit_state():
    _hits.clear()
    yield
    _hits.clear()