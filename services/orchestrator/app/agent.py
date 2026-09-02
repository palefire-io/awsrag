"""Pydantic AI agents, one per specialist agent (model + prompt module).

All agents run the same code path — Gemma (or a per-agent override) on Bedrock via
the Converse API with IAM auth. What differs is the model id and the system prompt,
both supplied when the agent is built. Retrieved context is passed per run as deps.
"""

from dataclasses import dataclass

from pydantic_ai import Agent, RunContext
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.models.bedrock import BedrockConverseModel
from pydantic_ai.providers.bedrock import BedrockProvider

from .prompts import PromptFlow


@dataclass
class Deps:
    context: str


def build_agent(model_id: str, prompt: PromptFlow, region: str) -> Agent[Deps, str]:
    model = BedrockConverseModel(model_id, provider=BedrockProvider(region_name=region))
    agent = Agent(model, deps_type=Deps)

    @agent.instructions
    def _with_context(ctx: RunContext[Deps]) -> str:
        if not ctx.deps.context:
            return prompt.system_prompt
        return f"{prompt.system_prompt}\n\nRetrieved context:\n{ctx.deps.context}"

    return agent


def to_message_history(messages: list[dict]) -> list[ModelMessage]:
    """Convert prior OpenAI-format turns into Pydantic AI history (final user turn handled separately)."""
    history: list[ModelMessage] = []
    for msg in messages:
        role, content = msg.get("role"), msg.get("content") or ""
        if role == "user":
            history.append(ModelRequest(parts=[UserPromptPart(content=content)]))
        elif role == "assistant":
            history.append(ModelResponse(parts=[TextPart(content=content)]))
    return history
