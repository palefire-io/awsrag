"""Multi-agent OpenAI-compatible orchestrator, plus the chat + admin SPA.

Serves the OpenWebUI-replacement frontend directly: each Agent Silo is surfaced as a
selectable model via `/v1/models`; `/v1/chat/completions` routes by the `model` field
to that agent's database (for retrieval, filtered by the caller's Cognito roles) and
prompt module (for behaviour). `/api/admin/*` (see admin.py) lets a Superuser review
and publish documents staged by the UIMediated ingest workflow. The built SPA
(services/orchestrator/frontend) is mounted at "/" last, so it can't shadow any of
the routes above.
"""

import json
import time
import uuid
from contextlib import asynccontextmanager

import boto3
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import admin
from .agent import Deps, build_agent, to_message_history
from .auth import UserContext, require_user
from .config import get_settings
from .prompts import get_prompt
from .rag import SUPERUSER, Retriever
from .registry import AgentInfo, AgentRegistry

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.registry = AgentRegistry(settings)
    app.state.retriever = Retriever(settings)
    app.state.agents = {}  # (model_id, prompt_module) -> Pydantic AI Agent
    app.state.pending_documents = boto3.resource(
        "dynamodb", region_name=settings.region
    ).Table(settings.pending_documents_table)
    try:
        yield
    finally:
        await app.state.retriever.close()


app = FastAPI(title="CloudRAG Orchestrator", lifespan=lifespan)


def _agent_for(info: AgentInfo):
    """Build (and cache) the Pydantic AI agent for a registry entry."""
    key = (info.llm_model_id, info.prompt_module)
    agent = app.state.agents.get(key)
    if agent is None:
        agent = build_agent(info.llm_model_id, get_prompt(info.prompt_module), settings.region)
        app.state.agents[key] = agent
    return agent


def _permitted(user: UserContext, info: AgentInfo) -> bool:
    """Whether a caller may use this silo at all.

    Distinct from rag.py's per-document `allowed_roles` filter: that decides
    which documents are visible *within* a silo, and never gated reaching the
    silo in the first place. A silo that registered no roles is reachable only
    by a Superuser -- fail closed rather than open.
    """
    if SUPERUSER in user.groups:
        return True
    return bool(set(user.groups) & set(info.roles))


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok"}


@app.get("/v1/models")
async def list_models(user: UserContext = Depends(require_user)) -> dict:
    return {
        "object": "list",
        "data": [
            {"id": a.id, "object": "model", "created": 0, "owned_by": "cloudrag", "name": a.display_name}
            for a in app.state.registry.list()
            if _permitted(user, a)
        ],
    }


def _chunk(completion_id: str, model: str, delta: dict, finish_reason: str | None) -> str:
    payload = {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    return f"data: {json.dumps(payload)}\n\n"


@app.post("/v1/chat/completions")
async def chat_completions(body: dict, user: UserContext = Depends(require_user)):
    model = body.get("model")
    info = app.state.registry.get(model) if model else None
    # 404 rather than 403: a silo the caller has no role in shouldn't be
    # distinguishable from one that doesn't exist.
    if info is None or not _permitted(user, info):
        raise HTTPException(status_code=404, detail=f"unknown agent/model: {model!r}")

    messages = body.get("messages", [])
    if not messages:
        raise HTTPException(status_code=400, detail="messages must not be empty")
    prompt = messages[-1].get("content") or ""
    stream = bool(body.get("stream", False))

    context = "\n\n---\n\n".join(
        await app.state.retriever.retrieve(
            info.database, prompt, roles=info.expand(user.groups)
        )
    )
    history = to_message_history(messages[:-1])
    deps = Deps(context=context)
    agent = _agent_for(info)
    completion_id = f"chatcmpl-{uuid.uuid4().hex}"

    if not stream:
        result = await agent.run(prompt, message_history=history, deps=deps)
        return {
            "id": completion_id,
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": result.output},
                "finish_reason": "stop",
            }],
        }

    async def event_stream():
        yield _chunk(completion_id, model, {"role": "assistant"}, None)
        async with agent.run_stream(prompt, message_history=history, deps=deps) as result:
            async for delta in result.stream_text(delta=True):
                yield _chunk(completion_id, model, {"content": delta}, None)
        yield _chunk(completion_id, model, {}, "stop")
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


app.include_router(admin.router)

# the built chat+admin SPA -- mounted last so it can't shadow any route above
app.mount("/", StaticFiles(directory="frontend-dist", html=True), name="frontend")
