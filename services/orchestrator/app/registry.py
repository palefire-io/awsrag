"""Agent registry — discovers the deployed Agent Silos from SSM.

Each `AgentSiloStack` writes `/cloudrag/{stage}/agents/{id}/*`. The orchestrator
reads them (short TTL cache) to serve the model list and to route each request to
the right database + prompt module. New agents therefore appear without redeploying
the orchestrator, as long as their prompt module already ships in the image.
"""

import json
import time
from dataclasses import dataclass

from .config import Settings

_TTL_SECONDS = 30


@dataclass(frozen=True)
class AgentInfo:
    id: str
    display_name: str
    database: str
    prompt_module: str
    llm_model_id: str
    roles: list[str]


class AgentRegistry:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._cache: dict[str, AgentInfo] = {}
        self._loaded_at = 0.0

    def _load(self) -> dict[str, AgentInfo]:
        raw: dict[str, dict[str, str]] = {}
        paginator = self._settings.ssm.get_paginator("get_parameters_by_path")
        for page in paginator.paginate(Path=self._settings.agents_path, Recursive=True):
            for param in page["Parameters"]:
                # /cloudrag/{stage}/agents/{id}/{field}
                _, _, agent_id, field = param["Name"].rsplit("/", 3)
                raw.setdefault(agent_id, {})[field] = param["Value"]

        agents: dict[str, AgentInfo] = {}
        for agent_id, fields in raw.items():
            if "database" not in fields:
                continue  # incomplete registration, skip
            agents[agent_id] = AgentInfo(
                id=agent_id,
                display_name=fields.get("display-name", agent_id),
                database=fields["database"],
                prompt_module=fields.get("prompt-module", "default"),
                llm_model_id=fields.get("llm-model-id") or self._settings.default_llm_model_id,
                roles=json.loads(fields.get("roles", "[]")),
            )
        return agents

    def _refresh(self) -> None:
        if time.monotonic() - self._loaded_at > _TTL_SECONDS or not self._cache:
            self._cache = self._load()
            self._loaded_at = time.monotonic()

    def list(self) -> list[AgentInfo]:
        self._refresh()
        return sorted(self._cache.values(), key=lambda a: a.display_name)

    def get(self, agent_id: str) -> AgentInfo | None:
        self._refresh()
        return self._cache.get(agent_id)
