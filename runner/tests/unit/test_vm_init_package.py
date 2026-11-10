# SPDX-License-Identifier: LicenseRef-Proprietary

"""vm-init is copied into a root file system without the runner (#977): the package imports the
standard library and itself, and nothing else, so `python3 vm-init` runs there."""

import ast
import sys
from pathlib import Path

import code_reviewer_runner.vm_init as package

PACKAGE = Path(package.__file__ or "").parent


def _imports(path: Path) -> list[tuple[str, int]]:
    """(top-level module name, relative level) of every import in the file."""
    found: list[tuple[str, int]] = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            found.extend((alias.name.split(".")[0], 0) for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            found.append(((node.module or "").split(".")[0], node.level))
    return found


# #977-T02
def test_the_package_imports_only_the_standard_library_and_itself() -> None:
    files = sorted(PACKAGE.glob("*.py"))
    assert len(files) >= 8

    for path in files:
        for name, level in _imports(path):
            if level > 0:
                assert level == 1, f"{path.name}: a relative import that leaves the package"
                continue
            assert name in sys.stdlib_module_names, f"{path.name} imports {name}"


# #977-T02
def test_every_file_of_the_package_starts_with_the_license_header() -> None:
    for path in PACKAGE.glob("*.py"):
        assert path.read_text(encoding="utf-8").startswith(
            "# SPDX-License-Identifier: LicenseRef-Proprietary\n"
        ), path.name
