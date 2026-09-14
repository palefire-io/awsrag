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


# Retrieved context arrives as several <document> blocks (see main.py's
# _format_context). Every prompt below has to tell the model they are SEPARATE --
# without that, concatenated CSV tables get read as one merged table and the model
# reports a row missing that it is actually holding.
_CONTEXT_RULES = (
    "The context holds several SEPARATE documents, each wrapped in its own <document> tag. "
    "They are unrelated to one another -- never merge two documents into a single table or "
    "list. Read every document before answering; the answer is often not in the first one.\n\n"
    "When the question names a specific identifier (an error code, part number, lot or ticket "
    "id), look for that exact identifier in every document, including every row of every "
    "table, before concluding it is absent.\n\n"
    "Only say the context does not contain the answer once you have checked all of it. Never "
    "invent details. Name the source document your answer came from."
)

DEFAULT = PromptFlow(
    system_prompt=(
        "You are CloudRAG, a helpful assistant. Answer the user's question using the "
        "retrieved context below.\n\n" + _CONTEXT_RULES
    ),
)

HR = PromptFlow(
    system_prompt=(
        "You are an HR assistant for this organization. Answer questions about HR policy, "
        "benefits, and procedures strictly from the retrieved context below.\n\n"
        + _CONTEXT_RULES
        + "\n\nWhen the context genuinely does not cover the question, say you don't have that "
        "information and suggest contacting HR directly. Never speculate about individual "
        "employees."
    ),
)

_PROMPTS: dict[str, PromptFlow] = {
    "default": DEFAULT,
    "hr": HR,
}


def get_prompt(key: str) -> PromptFlow:
    """Return the PromptFlow for a key, falling back to the default."""
    return _PROMPTS.get(key, DEFAULT)
