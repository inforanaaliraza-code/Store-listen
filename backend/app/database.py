from collections.abc import Generator, Iterable
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

from pymongo import MongoClient
from pymongo.errors import PyMongoError
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.sql.elements import BinaryExpression, BooleanClauseList, Grouping, UnaryExpression
from sqlalchemy.sql import operators
from sqlalchemy.sql.schema import UniqueConstraint
from sqlalchemy.sql.visitors import Visitable
from sqlalchemy import inspect as sa_inspect

from app.config import settings


class Base(DeclarativeBase):
    pass


if settings.app_env.lower() == "test":
    import mongomock

    client = mongomock.MongoClient(tz_aware=True)
else:
    client = MongoClient(settings.mongodb_uri, serverSelectionTimeoutMS=10_000, tz_aware=True) if settings.mongodb_uri else None
mongo_database = client[settings.mongo_database_name] if client else None


def _expression_filter(expression: Any) -> dict[str, Any]:
    if isinstance(expression, Grouping):
        return _expression_filter(expression.element)
    if isinstance(expression, BooleanClauseList):
        clauses = [_expression_filter(clause) for clause in expression.clauses]
        if expression.operator is operators.or_:
            return {"$or": clauses}
        if expression.operator is operators.and_:
            return {"$and": clauses}
    if isinstance(expression, UnaryExpression):
        if expression.operator is operators.inv:
            return {"$nor": [_expression_filter(expression.element)]}
    if isinstance(expression, BinaryExpression):
        field = expression.left.key
        right = expression.right
        if hasattr(right, "value"):
            value = right.value
        else:
            value = {"true": True, "false": False, "null": None}.get(right.__visit_name__)
        operator_map = {
            operators.eq: "$eq",
            operators.ne: "$ne",
            operators.gt: "$gt",
            operators.ge: "$gte",
            operators.lt: "$lt",
            operators.le: "$lte",
            operators.is_: "$eq",
            operators.is_not: "$ne",
            operators.in_op: "$in",
            operators.not_in_op: "$nin",
        }
        mongo_operator = operator_map.get(expression.operator)
        if mongo_operator is None:
            raise TypeError(f"Unsupported MongoDB filter operator: {expression.operator}")
        if mongo_operator in {"$in", "$nin"}:
            value = list(value)
        if mongo_operator == "$eq" and value is None:
            return {field: None}
        return {field: {mongo_operator: value}}
    raise TypeError(f"Unsupported MongoDB filter expression: {type(expression).__name__}")


class MongoQuery:
    def __init__(self, session: "MongoSession", model: type, filters=None, sort=None, skip=0, take=None):
        self.session = session
        self.model = model
        self.filters = list(filters or [])
        self.sort = list(sort or [])
        self.skip = skip
        self.take = take

    def _clone(self) -> "MongoQuery":
        return MongoQuery(self.session, self.model, self.filters, self.sort, self.skip, self.take)

    def filter(self, *expressions: Any) -> "MongoQuery":
        query = self._clone()
        query.filters.extend(expressions)
        return query

    def order_by(self, *columns: Any) -> "MongoQuery":
        query = self._clone()
        for column in columns:
            descending = isinstance(column, UnaryExpression) and column.modifier is operators.desc_op
            target = column.element if isinstance(column, UnaryExpression) else column
            query.sort.append((target.key, -1 if descending else 1))
        return query

    def offset(self, count: int) -> "MongoQuery":
        query = self._clone()
        query.skip = count
        return query

    def limit(self, count: int) -> "MongoQuery":
        query = self._clone()
        query.take = count
        return query

    def _selector(self) -> dict[str, Any]:
        clauses = [_expression_filter(expression) for expression in self.filters]
        if not clauses:
            return {}
        return clauses[0] if len(clauses) == 1 else {"$and": clauses}

    def all(self) -> list[Any]:
        cursor = self.session.database[self.model.__tablename__].find(self._selector())
        if self.sort:
            cursor = cursor.sort(self.sort)
        if self.skip:
            cursor = cursor.skip(self.skip)
        if self.take is not None:
            cursor = cursor.limit(self.take)
        return [self.session._materialize(self.model, document) for document in cursor]

    def first(self) -> Any | None:
        rows = self.limit(1).all()
        return rows[0] if rows else None

    def one_or_none(self) -> Any | None:
        rows = self.limit(2).all()
        if len(rows) > 1:
            raise ValueError("Expected at most one MongoDB document")
        return rows[0] if rows else None

    def one(self) -> Any:
        rows = self.limit(2).all()
        if len(rows) != 1:
            raise LookupError(f"Expected exactly one MongoDB document, found {len(rows)}")
        return rows[0]

    def count(self) -> int:
        return self.session.database[self.model.__tablename__].count_documents(self._selector())

    def delete(self, **_kwargs: Any) -> int:
        result = self.session.database[self.model.__tablename__].delete_many(self._selector())
        return result.deleted_count


class MongoSession:
    def __init__(self):
        if mongo_database is None:
            raise RuntimeError("MONGODB_URI is required to connect to the application database.")
        self.database = mongo_database
        self._pending: dict[int, Any] = {}
        self._tracked: dict[int, tuple[Any, dict[str, Any]]] = {}

    def __enter__(self) -> "MongoSession":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    def query(self, model: type, *other_entities: Any) -> MongoQuery:
        if other_entities:
            raise TypeError("MongoDB document queries accept one model at a time")
        return MongoQuery(self, model)

    def get(self, model: type, record_id: Any) -> Any | None:
        primary_key = sa_inspect(model).primary_key[0].key
        document = self.database[model.__tablename__].find_one({primary_key: record_id})
        return self._materialize(model, document) if document else None

    def add(self, item: Any) -> None:
        self._pending[id(item)] = item

    def add_all(self, items: Iterable[Any]) -> None:
        for item in items:
            self.add(item)

    def delete(self, item: Any) -> None:
        model = type(item)
        primary_key = sa_inspect(model).primary_key[0].key
        self.database[model.__tablename__].delete_one({primary_key: getattr(item, primary_key)})
        self._tracked.pop(id(item), None)
        self._pending.pop(id(item), None)

    def has_references(self, model: type, record_id: Any) -> bool:
        target = sa_inspect(model).primary_key[0]
        target_name = f"{target.table.name}.{target.name}"
        for table in Base.metadata.tables.values():
            for column in table.columns:
                if any(foreign_key.target_fullname == target_name for foreign_key in column.foreign_keys):
                    if self.database[table.name].count_documents({column.name: record_id}, limit=1):
                        return True
        return False

    def ping(self) -> None:
        client.admin.command("ping")

    def commit(self) -> None:
        for item in self._pending.values():
            self._apply_defaults(item)
            document = self._document(item)
            primary_key = sa_inspect(type(item)).primary_key[0].key
            self.database[type(item).__tablename__].replace_one(
                {primary_key: document[primary_key]}, document, upsert=True
            )
            self._tracked[id(item)] = (item, deepcopy(document))
        self._pending.clear()
        for item, original in self._tracked.values():
            document = self._document(item)
            if document != original:
                primary_key = sa_inspect(type(item)).primary_key[0].key
                self.database[type(item).__tablename__].replace_one(
                    {primary_key: document[primary_key]}, document, upsert=True
                )
                self._tracked[id(item)] = (item, deepcopy(document))

    def flush(self) -> None:
        self.commit()

    def rollback(self) -> None:
        self._pending.clear()
        for item, original in self._tracked.values():
            for key, value in original.items():
                setattr(item, key, deepcopy(value))

    def refresh(self, item: Any) -> None:
        model = type(item)
        primary_key = sa_inspect(model).primary_key[0].key
        document = self.database[model.__tablename__].find_one({primary_key: getattr(item, primary_key)})
        if document is None:
            raise LookupError(f"{model.__name__} record no longer exists")
        self._set_document(item, document)
        self._tracked[id(item)] = (item, deepcopy(self._document(item)))

    def _materialize(self, model: type, document: dict[str, Any]) -> Any:
        values = {key: value for key, value in document.items() if key != "_id"}
        item = model(**values)
        self._tracked[id(item)] = (item, deepcopy(values))
        return item

    @staticmethod
    def _set_document(item: Any, document: dict[str, Any]) -> None:
        for key, value in document.items():
            if key != "_id":
                setattr(item, key, value)

    @staticmethod
    def _document(item: Any) -> dict[str, Any]:
        return {column.key: getattr(item, column.key) for column in sa_inspect(type(item)).columns}

    @staticmethod
    def _apply_defaults(item: Any) -> None:
        for column in sa_inspect(type(item)).columns:
            if column.key in item.__dict__:
                continue
            if column.default is not None:
                default = column.default.arg
                value = default() if callable(default) else default
                setattr(item, column.key, value)
            elif column.server_default is not None and "now" in str(column.server_default.arg).lower():
                setattr(item, column.key, datetime.now(UTC))

    def close(self) -> None:
        self._pending.clear()
        self._tracked.clear()


Session = MongoSession
SessionLocal = MongoSession


def check_database_connection() -> None:
    if client is None:
        raise RuntimeError("MONGODB_URI is required to connect to the application database.")
    client.admin.command("ping")
    for table in Base.metadata.sorted_tables:
        collection = mongo_database[table.name]
        collection.create_index("id", unique=True)
        for index in table.indexes:
            keys = [(column.name, 1) for column in index.columns]
            collection.create_index(keys, unique=index.unique)
        for constraint in table.constraints:
            if isinstance(constraint, UniqueConstraint):
                keys = [(column.name, 1) for column in constraint.columns]
                collection.create_index(keys, unique=True)


def get_db() -> Generator[MongoSession, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
