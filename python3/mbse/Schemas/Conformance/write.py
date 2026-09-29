"""Writes this implementation's conformance snapshots: `python -m mbse.Schemas.Conformance.write [directory]`.

The default directory is `conformance/python3` at the repository root.
"""

from __future__ import annotations

import sys
from pathlib import Path

from mbse.Schemas.Conformance.Corpus import build
from mbse.Schemas.Framework import JSON, YAML

DEFAULT = Path(__file__).resolve().parents[4] / "conformance" / "python3"


def render(corpus: dict | None = None) -> dict[str, str]:
    """File name -> text for every case, as this implementation writes them. Pass an already built corpus to avoid
    registering its schemas twice."""
    files = {}
    for case, (schema, root) in (corpus if corpus is not None else build()).items():
        files[f"{case}.json"] = JSON.ToJSON.Reachable(schema, root, indent=2) + "\n"
        files[f"{case}.yaml"] = YAML.ToYAML.Reachable(schema, root)
    return files


def main(directory: Path = DEFAULT) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for name, text in render().items():
        (directory / name).write_text(text, encoding="utf-8")
        print("wrote", directory / name)


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT)
