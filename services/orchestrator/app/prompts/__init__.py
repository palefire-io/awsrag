"""Prompt/flow modules — one per specialist agent behaviour.

Each Agent Silo names a `promptModule` (see config/agent-silos.ts); that key maps
here to a PromptFlow. Adding a genuinely new specialist behaviour means adding a
PromptFlow below and redeploying the orchestrator image; a new agent that reuses an
existing behaviour needs only a config entry.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class PromptFlow:
    """The per-agent system prompt (extend with retrieval/formatting hooks as needed)."""
    system_prompt: str


DEFAULT = PromptFlow(
    system_prompt=(
        "You are CloudRAG, a helpful assistant. Answer the user's question using the "
        "retrieved context when it is relevant. If the context does not contain the answer, "
        "say so rather than inventing details."
    ),
)

HR = PromptFlow(
    system_prompt=(
        "You are an HR assistant for this organization. Answer questions about HR policy, "
        "benefits, and procedures strictly from the retrieved context. When the context does "
        "not cover the question, say you don't have that information and suggest contacting HR "
        "directly. Never speculate about individual employees."
    ),
)

_PROMPTS: dict[str, PromptFlow] = {
    "default": DEFAULT,
    "hr": HR,
}


def get_prompt(key: str) -> PromptFlow:
    """Return the PromptFlow for a key, falling back to the default."""
    return _PROMPTS.get(key, DEFAULT)
