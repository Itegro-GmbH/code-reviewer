# SPDX-License-Identifier: LicenseRef-Proprietary

"""Test helper, not a test: does an object hold a secret anywhere in the state it can reach (#974)?

The local dispatcher must hold no git token and no model key: not in its fields, not in what those
hold, not in a closure, not in a log line. `holds` walks what an object reaches (attributes,
containers, closures, the dataclasses and objects of this package) and returns the path of the first
place a needle is found, or None. Anything else (modules, classes, loggers, event loops, threads) is
a leaf: the log is checked from its text.
"""

import functools
import types
from typing import Any

_MAX_DEPTH = 14
_OURS = "code_reviewer_runner"


def holds(root: object, needles: tuple[str, ...]) -> str | None:
    """The path to the first value of `root`'s reachable state that contains one of `needles`."""
    seen: set[int] = set()
    return _walk(root, needles, "root", 0, seen)


def _contains(value: str | bytes | bytearray, needles: tuple[str, ...]) -> bool:
    text = value if isinstance(value, str) else bytes(value).decode("latin-1")
    return any(needle in text or needle.encode().decode("latin-1") in text for needle in needles)


def _walk(obj: Any, needles: tuple[str, ...], path: str, depth: int, seen: set[int]) -> str | None:
    if depth > _MAX_DEPTH or id(obj) in seen:
        return None
    if isinstance(obj, (str, bytes, bytearray)):
        return path if _contains(obj, needles) else None
    if obj is None or isinstance(obj, (bool, int, float, type, types.ModuleType)):
        return None
    seen.add(id(obj))
    children: list[tuple[str, Any]] = []
    if isinstance(obj, dict):
        entries: list[tuple[Any, Any]] = list(obj.items())  # pyright: ignore[reportUnknownArgumentType,reportUnknownMemberType]
        for key, value in entries:
            children.append((f"{path}[{key!r}]", key))
            children.append((f"{path}[{key!r}]", value))
    elif isinstance(obj, (list, tuple, set, frozenset)):
        children = [(f"{path}[{index}]", item) for index, item in enumerate(obj)]  # pyright: ignore[reportUnknownVariableType,reportUnknownArgumentType]
    elif isinstance(obj, functools.partial):
        children = [
            (f"{path}.func", obj.func),
            (f"{path}.args", obj.args),
            (f"{path}.keywords", obj.keywords),
        ]  # pyright: ignore[reportUnknownMemberType]
    elif isinstance(obj, types.MethodType):
        children = [(f"{path}.__self__", obj.__self__)]
    elif isinstance(obj, types.FunctionType):
        cells = [(f"{path}.<closure {i}>", cell) for i, cell in enumerate(obj.__closure__ or ())]
        children = [*cells, (f"{path}.__defaults__", obj.__defaults__)]
        for index, cell in enumerate(obj.__closure__ or ()):
            try:
                children.append((f"{path}.<closure {index}>", cell.cell_contents))
            except ValueError:
                continue
    elif type(obj).__module__.startswith(_OURS) or type(obj).__module__ == "builtins":
        attributes: dict[str, Any] = dict(getattr(obj, "__dict__", {}))
        for klass in type(obj).__mro__:
            for slot in getattr(klass, "__slots__", ()):
                if hasattr(obj, slot):
                    attributes[slot] = getattr(obj, slot)
        children = [(f"{path}.{name}", value) for name, value in attributes.items()]
    for child_path, child in children:
        found = _walk(child, needles, child_path, depth + 1, seen)
        if found is not None:
            return found
    return None
