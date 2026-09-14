"""Vector indexer Lambda (multi-agent).

Consumes the one shared ingest queue and routes each message to the right Agent
Silo database. The agent is resolved from the source S3 bucket (or an `agent` field
on a direct message) via the SSM registry the AgentSiloStacks publish; the message
is then optionally PII-redacted (per-agent flag), embedded with Titan v2, and
upserted into that agent's `embeddings` table. Schema is provisioned per agent by
the siloProvisioner, so this Lambda assumes the table exists.

Failures are reported per-record (partial batch response) so only the failed
message is redelivered and, after maxReceiveCount, lands in the DLQ.
"""

import json
import logging
import os
import time
from decimal import Decimal
from enum import Enum
from urllib.parse import unquote_plus

import boto3
import pg8000.native

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ["AWS_REGION"]
DB_SECRET_ARN = os.environ["DB_SECRET_ARN"]
EMBED_MODEL_ID = os.environ["EMBED_MODEL_ID"]
EMBED_DIMENSIONS = int(os.environ["EMBED_DIMENSIONS"])
COMPREHEND_LANGUAGE = os.environ.get("COMPREHEND_LANGUAGE", "en")
STAGE = os.environ.get("STAGE", "dev")
AGENTS_PATH = f"/cloudrag/{STAGE}/agents"

# Comprehend's real-time DetectPiiEntities accepts up to 100 KB of UTF-8 text.
COMPREHEND_MAX_BYTES = 100_000
ROUTES_TTL_SECONDS = 60

_secretsmanager = boto3.client("secretsmanager", region_name=REGION)
_comprehend = boto3.client("comprehend", region_name=REGION)
_bedrock = boto3.client("bedrock-runtime", region_name=REGION)
_s3 = boto3.client("s3", region_name=REGION)
_ssm = boto3.client("ssm", region_name=REGION)
_pending_table = boto3.resource("dynamodb", region_name=REGION).Table(os.environ["PENDING_DOCUMENTS_TABLE"])

# reused across warm invocations
_conns: dict = {}          # database name -> pg8000 connection
_db_secret: dict | None = None
_routes: tuple | None = None  # (by_bucket, by_id)
_routes_at = 0.0


class IngestState(str, Enum):
    RECEIVED = "received"    # pulled from SQS
    ROUTED = "routed"        # resolved to an agent database
    FETCHED = "fetched"      # source text obtained (S3 GetObject or inline)
    REDACTED = "redacted"    # PII redaction done (or deliberately skipped)
    EMBEDDED = "embedded"    # Titan v2 embedding generated
    PERSISTED = "persisted"  # row written to pgvector, AllUser workflow (terminal success)
    REGISTERED = "registered"  # staged in DynamoDB, UIMediated workflow (terminal success)
    FAILED = "failed"        # terminal failure (-> DLQ)


def handler(event, context):
    """SQS batch entry point. Returns partial-batch failures for retry/DLQ routing."""
    failures = []
    for record in event.get("Records", []):
        message_id = record["messageId"]
        state = IngestState.RECEIVED
        source_id = None
        try:
            source_id, text, agent = _extract_source(record)
            state = IngestState.ROUTED

            state = IngestState.FETCHED
            content = _redact(text) if agent["redact"] else text
            state = IngestState.REDACTED

            embedding = _embed(content)
            state = IngestState.EMBEDDED

            if agent["ingest_workflow"] == "UIMediated":
                role = _classify(agent, source_id)
                if role is None:
                    _register_pending(agent["id"], source_id, content, embedding)
                    state = IngestState.REGISTERED
                else:
                    # pre-classified by filename: store the MINIMUM role that may see
                    # it. Seniority is applied at query time, so no need to enumerate
                    # every senior role here.
                    _persist(agent["database"], source_id, content, embedding, [role])
                    state = IngestState.PERSISTED
            else:
                roles = agent["roles"]
                # An empty allowed_roles array reads as PUBLIC to the retrieval
                # filter, so a silo with no registered roles must fail to the DLQ
                # rather than quietly publishing the document to everyone.
                if not roles:
                    raise ValueError(f"agent {agent['id']!r} has no roles registered")
                _persist(agent["database"], source_id, content, embedding, roles)
                state = IngestState.PERSISTED

            logger.info(json.dumps({"agent": agent["id"], "database": agent["database"],
                                    "source_id": source_id, "state": state.value,
                                    "redacted": agent["redact"]}))
        except Exception as exc:  # noqa: BLE001 - route any failure to the DLQ path
            logger.exception(json.dumps({"source_id": source_id, "failed_state": state.value,
                                         "error": str(exc)}))
            failures.append({"itemIdentifier": message_id})

    return {"batchItemFailures": failures}


def _extract_source(record):
    """Return (source_id, text, agent) — resolving which agent database to write to."""
    body = json.loads(record["body"])
    by_bucket, by_id = _routes_now()

    # S3 -> SQS notification: body has Records[].s3.{bucket,object}; route by bucket
    s3_records = body.get("Records") if isinstance(body, dict) else None
    if s3_records and isinstance(s3_records, list) and "s3" in s3_records[0]:
        s3_info = s3_records[0]["s3"]
        bucket = s3_info["bucket"]["name"]
        agent = by_bucket.get(bucket)
        if agent is None:
            raise ValueError(f"no agent registered for bucket {bucket!r}")
        key = unquote_plus(s3_info["object"]["key"])
        text = _s3.get_object(Bucket=bucket, Key=key)["Body"].read().decode("utf-8")
        return f"s3://{bucket}/{key}", text, agent

    # direct producer message: {"agent": "hr", "id": ..., "text": ...}
    if isinstance(body, dict) and "text" in body:
        agent = by_id.get(body.get("agent"))
        if agent is None:
            raise ValueError(f"unknown or missing agent on direct message: {body.get('agent')!r}")
        source_id = str(body.get("id") or record["messageId"])
        return source_id, body["text"], agent

    raise ValueError("message is neither an S3 event nor an {agent,id,text} payload")


def _classify(agent, source_id):
    """Role implied by a `<Prefix>__` filename, or None if a human must decide.

    The corpus names every pre-classified document `<Prefix>__<slug>.<ext>` and the
    slug never contains a double underscore, so splitting on the first one is
    unambiguous (see corpora/hr_corpus/manifest.json). An unrecognised or absent
    prefix returns None, which routes the document to the review queue.
    """
    mapping = agent.get("auto_classify")
    if not mapping:
        return None
    filename = source_id.rsplit("/", 1)[-1]
    prefix, separator, _ = filename.partition("__")
    if not separator:
        return None
    return mapping.get(prefix)


def _routes_now():
    """(by_bucket, by_id) routing maps from the SSM agent registry, cached with a TTL."""
    global _routes, _routes_at
    if _routes is None or time.monotonic() - _routes_at > ROUTES_TTL_SECONDS:
        raw: dict = {}
        for page in _ssm.get_paginator("get_parameters_by_path").paginate(Path=AGENTS_PATH, Recursive=True):
            for param in page["Parameters"]:
                _, _, agent_id, field = param["Name"].rsplit("/", 3)
                raw.setdefault(agent_id, {})[field] = param["Value"]
        by_bucket, by_id = {}, {}
        for agent_id, fields in raw.items():
            if "database" not in fields:
                continue
            redact = str(fields.get("redact", "true")).lower() not in ("false", "0", "no", "")
            entry = {
                "id": agent_id,
                "database": fields["database"],
                "redact": redact,
                "ingest_workflow": fields.get("ingest-workflow", "AllUser"),
                "roles": json.loads(fields.get("roles", "[]")),
                "auto_classify": json.loads(fields.get("auto-classify", "{}")),
            }
            by_id[agent_id] = entry
            if "bucket" in fields:
                by_bucket[fields["bucket"]] = entry
        _routes, _routes_at = (by_bucket, by_id), time.monotonic()
    return _routes


def _redact(text):
    """Replace each PII span Comprehend finds with a [REDACTED-<TYPE>] token."""
    truncated = text.encode("utf-8")[:COMPREHEND_MAX_BYTES].decode("utf-8", "ignore")
    entities = _comprehend.detect_pii_entities(
        Text=truncated, LanguageCode=COMPREHEND_LANGUAGE
    ).get("Entities", [])

    # apply spans right-to-left so earlier offsets stay valid as we splice
    redacted = truncated
    for entity in sorted(entities, key=lambda e: e["BeginOffset"], reverse=True):
        begin, end = entity["BeginOffset"], entity["EndOffset"]
        redacted = redacted[:begin] + f"[REDACTED-{entity['Type']}]" + redacted[end:]
    return redacted


def _embed(text):
    """Generate a 1024-dim embedding with Titan Text Embeddings v2."""
    response = _bedrock.invoke_model(
        modelId=EMBED_MODEL_ID,
        body=json.dumps({
            "inputText": text,
            "dimensions": EMBED_DIMENSIONS,
            "normalize": True,
        }),
    )
    return json.loads(response["body"].read())["embedding"]


def _persist(database, source_id, content, embedding, allowed_roles):
    """Idempotently upsert the row keyed by source_id into the agent's database."""
    conn = _get_db(database)
    vector_literal = "[" + ",".join(repr(float(x)) for x in embedding) + "]"
    conn.run(
        """
        INSERT INTO embeddings (source_id, content, embedding, allowed_roles)
        VALUES (:source_id, :content, CAST(:embedding AS vector), :allowed_roles)
        ON CONFLICT (source_id)
        DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding,
                      allowed_roles = EXCLUDED.allowed_roles
        """,
        source_id=source_id, content=content, embedding=vector_literal, allowed_roles=allowed_roles,
    )


def _register_pending(agent_id, source_id, content, embedding):
    """Stage a UIMediated document in DynamoDB pending an admin's role selection.

    Not written to Postgres at all yet -- the embedding is precomputed so a future
    publish step doesn't need to call Bedrock again, just insert with chosen roles.
    """
    _pending_table.put_item(Item={
        "agentId": agent_id,
        "sourceId": source_id,
        "content": content,
        "embedding": [Decimal(str(x)) for x in embedding],
        "status": "pending",
        "createdAt": int(time.time()),
    })


def _get_db(database):
    """Return a live pg8000 connection to the given agent database (cached per database)."""
    global _db_secret
    conn = _conns.get(database)
    if conn is not None:
        try:
            conn.run("SELECT 1")
            return conn
        except Exception:  # noqa: BLE001 - stale connection, reconnect below
            _conns.pop(database, None)

    if _db_secret is None:
        _db_secret = json.loads(
            _secretsmanager.get_secret_value(SecretId=DB_SECRET_ARN)["SecretString"]
        )
    conn = pg8000.native.Connection(
        host=_db_secret["host"],
        port=int(_db_secret.get("port", 5432)),
        database=database,
        user=_db_secret["username"],
        password=_db_secret["password"],
    )
    _conns[database] = conn
    return conn
