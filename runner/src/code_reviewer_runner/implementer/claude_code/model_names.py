# SPDX-License-Identifier: LicenseRef-Proprietary

"""Which model names are the same model for Claude Code (#980): an alias such as `opus` and the ids it
stands for (`claude-opus-5-5`).

A runner announces the models of its subscription as the owner gave them (the aliases by default) and
a turn carries the model its profile names, an alias or an id. The app matches the two with the same
map (`app/src/runner-identity/model-aliases.ts`); this is the runner's copy, and
`contracts/claude-model-aliases.v1.json` holds the map and the test vectors that both sides' tests
run. The dispatcher uses it to pick the credential whose list allows a job's model.
"""

import re
from collections.abc import Sequence
from typing import Final

# alias -> the pattern of the ids it stands for (the contract file's copy; a test compares them).
ALIAS_ID_PATTERNS: Final = {
    "sonnet": r"^claude-([0-9]+(-[0-9]+)?-)?sonnet(-|$)",
    "opus": r"^claude-([0-9]+(-[0-9]+)?-)?opus(-|$)",
    "haiku": r"^claude-([0-9]+(-[0-9]+)?-)?haiku(-|$)",
}
_COMPILED: Final = {alias: re.compile(pattern) for alias, pattern in ALIAS_ID_PATTERNS.items()}


def alias_of(model: str) -> str | None:
    """The alias an id belongs to, or None (an alias, an id of no known family, any other name)."""
    for alias, pattern in _COMPILED.items():
        if pattern.search(model):
            return alias
    return None


def models_match(announced: str, demanded: str) -> bool:
    """Whether a model a device allows is the model a job asks for: equal, or an alias and an id it
    stands for. Never two different ids, never two different aliases."""
    return announced == demanded or alias_of(announced) == demanded or alias_of(demanded) == announced


def allows(models: Sequence[str] | None, demanded: str | None) -> bool:
    """Whether a list of models (None: the device allows any) allows the model a job names (None:
    the job names none)."""
    if models is None or demanded is None:
        return True
    return any(models_match(model, demanded) for model in models)


def covering(models: Sequence[str], demanded: str) -> tuple[str, ...]:
    """The entries of a list that stand for the model: what a refusal of that model takes away."""
    return tuple(model for model in models if models_match(model, demanded))
