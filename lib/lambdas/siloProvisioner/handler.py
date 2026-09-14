"""CloudFormation custom-resource handler that provisions an agent's database.

Invoked (via CDK's Provider framework) by each AgentSiloStack. On create/update it
creates the agent's database on the shared instance and bootstraps pgvector + the
`embeddings` table; on delete it drops the database only when allowed (dev), so
production data is retained.
"""

import json
import os
import re

import boto3
import pg8000.native

REGION = os.environ["AWS_REGION"]
DB_SECRET_ARN = os.environ["DB_SECRET_ARN"]
EMBED_DIMENSIONS = int(os.environ.get("EMBED_DIMENSIONS", "1024"))

_NAME_RE = re.compile(r"^[a-z0-9_]+$")
_secrets = boto3.client("secretsmanager", region_name=REGION)


def _secret() -> dict:
    return json.loads(_secrets.get_secret_value(SecretId=DB_SECRET_ARN)["SecretString"])


def _connect(database: str) -> pg8000.native.Connection:
    s = _secret()
    return pg8000.native.Connection(
        host=s["host"], port=int(s.get("port", 5432)), database=database,
        user=s["username"], password=s["password"],
    )


def _validate(database: str) -> str:
    if not _NAME_RE.match(database):
        raise ValueError(f"unsafe database name: {database!r}")
    return database


def _database_exists(admin: pg8000.native.Connection, database: str) -> bool:
    return bool(admin.run("SELECT 1 FROM pg_database WHERE datname = :n", n=database))


def _bootstrap_schema(database: str) -> None:
    conn = _connect(database)
    conn.run("CREATE EXTENSION IF NOT EXISTS vector")
    conn.run(
        f"""
        CREATE TABLE IF NOT EXISTS embeddings (
            id bigserial PRIMARY KEY,
            source_id text UNIQUE NOT NULL,
            content text,
            embedding vector({EMBED_DIMENSIONS}),
            created_at timestamptz DEFAULT now()
        )
        """
    )
    conn.run(
        "CREATE INDEX IF NOT EXISTS embeddings_embedding_hnsw "
        "ON embeddings USING hnsw (embedding vector_cosine_ops)"
    )
    # per-document role gate. Values are role names (which are literally Cognito Group
    # names, e.g. "Veridia-User", "HR-Manager"). Retrieval requires an overlap with the
    # caller's roles, so an empty array is visible to NOBODY -- "everyone in this silo"
    # is said by naming that silo's full role set.
    conn.run(
        "ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS "
        "allowed_roles text[] NOT NULL DEFAULT '{}'"
    )
    conn.close()


def _on_create_update(database: str) -> None:
    admin = _connect("postgres")
    if not _database_exists(admin, database):
        # CREATE DATABASE cannot run inside a transaction; pg8000 native autocommits.
        admin.run(f'CREATE DATABASE "{database}"')
    admin.close()
    _bootstrap_schema(database)


def _on_delete(database: str, allow_drop: bool) -> None:
    if not allow_drop:
        return  # production: retain the database
    admin = _connect("postgres")
    if _database_exists(admin, database):
        admin.run(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
    admin.close()


def handler(event, context):
    request_type = event["RequestType"]
    props = event["ResourceProperties"]
    database = _validate(props["Database"])
    allow_drop = str(props.get("AllowDrop", "false")).lower() == "true"

    if request_type in ("Create", "Update"):
        _on_create_update(database)
    elif request_type == "Delete":
        _on_delete(database, allow_drop)

    return {"PhysicalResourceId": database}
