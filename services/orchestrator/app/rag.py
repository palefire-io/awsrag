"""Retrieval helpers: embed a query, fetch nearest context from an agent's database.

One shared Postgres instance hosts one database per agent, so the retriever keeps a
connection pool per database (created lazily) and the same Titan v2 embeddings and
cosine HNSW query the ingest side writes.
"""

import asyncio
import json
import logging

import asyncpg
import boto3

from .config import Settings

logger = logging.getLogger("cloudrag.rag")

SUPERUSER = "Superuser"


class Retriever:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._bedrock = boto3.client("bedrock-runtime", region_name=settings.region)
        # one pool per agent database, created on first use
        self._pools: dict[str, asyncpg.Pool] = {}
        self._lock = asyncio.Lock()

    async def _get_pool(self, database: str) -> asyncpg.Pool:
        pool = self._pools.get(database)
        if pool is None:
            async with self._lock:
                pool = self._pools.get(database)
                if pool is None:
                    pool = await asyncpg.create_pool(
                        min_size=1, max_size=3, database=database, **self._settings.core_db,
                    )
                    self._pools[database] = pool
        return pool

    async def embed(self, text: str) -> list[float]:
        """Embed a query with Titan Text Embeddings v2 (blocking boto3 → threadpool)."""
        def _invoke() -> list[float]:
            response = self._bedrock.invoke_model(
                modelId=self._settings.embed_model_id,
                body=json.dumps({
                    "inputText": text,
                    "dimensions": self._settings.embed_dimensions,
                    "normalize": True,
                }),
            )
            return json.loads(response["body"].read())["embedding"]

        return await asyncio.to_thread(_invoke)

    async def retrieve(
        self, database: str, text: str, roles: list[str] | None = None
    ) -> list[tuple[str, str]]:
        """Return the top-k most similar (source_id, content) pairs visible to `roles`.

        A document is visible only where its `allowed_roles` overlaps the caller's,
        so an empty or NULL `allowed_roles` matches nobody. It used to mean "public",
        which made a forgotten tag the most dangerous kind of mistake. "Everyone in
        this silo" is now said explicitly, by tagging with the silo's full role set --
        what the AllUser ingest workflow does. The "Superuser" role still bypasses the
        filter entirely. `roles` are plain Cognito Group names (see
        config/agent-silos.ts) -- no id/translation step.
        """
        embedding = await self.embed(text)
        vector_literal = "[" + ",".join(repr(float(x)) for x in embedding) + "]"
        pool = await self._get_pool(database)
        try:
            rows = await pool.fetch(
                "SELECT source_id, content FROM embeddings "
                "WHERE allowed_roles && $3::text[] "
                "   OR $4 = ANY($3::text[]) "
                "ORDER BY embedding <=> $1::vector LIMIT $2",
                vector_literal, self._settings.rag_top_k, roles or [], SUPERUSER,
            )
        except asyncpg.exceptions.UndefinedTableError:
            logger.warning("embeddings table missing in %s; answering without retrieval", database)
            return []
        return [(r["source_id"], r["content"]) for r in rows if r["content"]]

    async def publish(self, database: str, source_id: str, content: str,
                       embedding: list[float], allowed_roles: list[str]) -> None:
        """Insert a staged (already-embedded) document into a silo's embeddings table.

        Mirrors vectorIndexer's `_persist` upsert -- no Bedrock call, the embedding
        was already computed at ingest time and is passed straight through.
        """
        vector_literal = "[" + ",".join(repr(float(x)) for x in embedding) + "]"
        pool = await self._get_pool(database)
        await pool.execute(
            "INSERT INTO embeddings (source_id, content, embedding, allowed_roles) "
            "VALUES ($1, $2, $3::vector, $4) "
            "ON CONFLICT (source_id) DO UPDATE SET content = EXCLUDED.content, "
            "embedding = EXCLUDED.embedding, allowed_roles = EXCLUDED.allowed_roles",
            source_id, content, vector_literal, allowed_roles,
        )

    async def close(self) -> None:
        for pool in self._pools.values():
            await pool.close()
