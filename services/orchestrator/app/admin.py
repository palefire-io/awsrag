"""Admin API: review UIMediated-workflow documents staged in DynamoDB and publish
them into a silo's embeddings table with chosen roles, or discard them.

Gated by the Superuser Cognito role (`require_superuser`) -- reuses the role that
already bypasses every RAG document filter, rather than introducing a separate
curator role. Routes read `request.app.state.registry`/`.retriever`/
`.pending_documents`, the same instances `main.py`'s lifespan already constructs --
no duplicate connection pools.
"""

from boto3.dynamodb.conditions import Key
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from .auth import require_superuser
from .config import get_settings

router = APIRouter(prefix="/api/admin")
settings = get_settings()


class PublishBody(BaseModel):
    roles: list[str]


@router.get("/config")
def get_config() -> dict:
    """No auth -- the login screen needs this before it has a token."""
    return {
        "userPoolId": settings.cognito_user_pool_id,
        "clientId": settings.cognito_client_id,
        "region": settings.region,
    }


@router.get("/agents", dependencies=[Depends(require_superuser)])
def list_agents(request: Request) -> list[dict]:
    return [
        {"id": a.id, "displayName": a.display_name, "roles": a.roles}
        for a in request.app.state.registry.list()
    ]


@router.get("/pending/{agent_id}", dependencies=[Depends(require_superuser)])
def list_pending(agent_id: str, request: Request) -> list[dict]:
    resp = request.app.state.pending_documents.query(
        KeyConditionExpression=Key("agentId").eq(agent_id)
    )
    return [
        {
            "sourceId": item["sourceId"],
            "content": item["content"],
            "createdAt": int(item["createdAt"]),
            "status": item["status"],
        }
        for item in resp["Items"]
    ]


@router.post("/pending/{agent_id}/{source_id}/publish", dependencies=[Depends(require_superuser)])
async def publish(agent_id: str, source_id: str, body: PublishBody, request: Request) -> dict:
    info = request.app.state.registry.get(agent_id)
    if info is None:
        raise HTTPException(status_code=404, detail=f"unknown agent: {agent_id!r}")

    unknown_roles = set(body.roles) - set(info.roles)
    if unknown_roles:
        raise HTTPException(status_code=400, detail=f"unknown role(s) for {agent_id!r}: {sorted(unknown_roles)}")

    table = request.app.state.pending_documents
    item = table.get_item(Key={"agentId": agent_id, "sourceId": source_id}).get("Item")
    if item is None:
        raise HTTPException(status_code=404, detail="no such pending document")

    embedding = [float(x) for x in item["embedding"]]
    await request.app.state.retriever.publish(info.database, source_id, item["content"], embedding, body.roles)
    table.delete_item(Key={"agentId": agent_id, "sourceId": source_id})
    return {"status": "published", "sourceId": source_id, "roles": body.roles}


@router.delete("/pending/{agent_id}/{source_id}", dependencies=[Depends(require_superuser)])
def discard(agent_id: str, source_id: str, request: Request) -> dict:
    request.app.state.pending_documents.delete_item(Key={"agentId": agent_id, "sourceId": source_id})
    return {"status": "discarded", "sourceId": source_id}
