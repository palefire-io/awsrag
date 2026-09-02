"""Runtime configuration for the multi-agent orchestrator.

The shared Postgres connection (host/port/credentials) is resolved once from the
Core stack's SSM parameters + secret. The *database* is per-agent and resolved per
request from the agent registry, so it is not part of this object.
"""

import functools
import json
import os

import boto3


def _env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None:
        raise RuntimeError(f"required environment variable {name} is not set")
    return value


class Settings:
    def __init__(self) -> None:
        self.region = _env("AWS_REGION", "eu-west-1")
        self.stage = _env("STAGE", "dev")
        self.embed_model_id = _env("EMBED_MODEL_ID", "amazon.titan-embed-text-v2:0")
        self.embed_dimensions = int(_env("EMBED_DIMENSIONS", "1024"))
        self.default_llm_model_id = _env("DEFAULT_LLM_MODEL_ID", "google.gemma-3-4b-it")
        self.rag_top_k = int(_env("RAG_TOP_K", "5"))

        # Cognito pool the orchestrator verifies caller JWTs (X-Cognito-Token) against.
        self.cognito_user_pool_id = _env("COGNITO_USER_POOL_ID")
        self.cognito_client_id = _env("COGNITO_CLIENT_ID")
        self.cognito_issuer = (
            f"https://cognito-idp.{self.region}.amazonaws.com/{self.cognito_user_pool_id}"
        )

        # DynamoDB staging table for UIMediated-workflow documents awaiting role selection.
        self.pending_documents_table = _env("PENDING_DOCUMENTS_TABLE")

        self.core_prefix = f"/cloudrag/{self.stage}/core"
        self.agents_path = f"/cloudrag/{self.stage}/agents"

        self._ssm = boto3.client("ssm", region_name=self.region)
        self._secrets = boto3.client("secretsmanager", region_name=self.region)

    @property
    def ssm(self):
        return self._ssm

    def _param(self, name: str) -> str:
        return self._ssm.get_parameter(Name=f"{self.core_prefix}/{name}")["Parameter"]["Value"]

    @functools.cached_property
    def core_db(self) -> dict:
        """Shared connection kwargs (no database — that's supplied per agent)."""
        secret_arn = self._param("secret-arn")
        secret = json.loads(self._secrets.get_secret_value(SecretId=secret_arn)["SecretString"])
        return {
            "host": self._param("endpoint"),
            "port": int(self._param("port")),
            "user": secret["username"],
            "password": secret["password"],
        }


@functools.lru_cache
def get_settings() -> Settings:
    return Settings()
