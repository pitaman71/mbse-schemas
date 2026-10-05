"""Writes a { previous, home, next } line at the top and bottom of every human-facing document of a repository.

The documents form one reading order, like a book: the README (home), MBSE.md, each language's tutorial and its
notebooks, the design documents, the conformance corpus, then each package's README and test plan. Agent-facing files
(AGENTS.md, CLAUDE.md, skills) and test notebooks are left alone. Each line is marked by an HTML comment, invisible when
rendered, so running this again replaces the lines rather than adding more.

    python3 scripts/nav.py [repository ...]     the repositories' roots; this one's by default

Like siblings.py, this is kept here and run for every mbse repository.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

MARK = "<!-- nav -->"
DESIGN_FIRST = {"FRAMEWORK.md", "EXPRESSIONS.md", "PATTERNS.md", "PROGRAMS.md"}


def order(root: Path) -> list[Path]:
    """The repository's documents in reading order."""
    docs = [root / "README.md", root / "MBSE.md"]
    for lang in ("python3", "typescript5"):
        tutorials = root / lang / "tutorials"
        if (tutorials / "README.md").exists():
            docs += [tutorials / "README.md", *sorted(tutorials.glob("[0-9]*.ipynb"))]
    design = sorted((root / "docs").glob("*.md"), key=lambda p: (p.name not in DESIGN_FIRST, p.name))
    docs += design + [root / "conformance" / "README.md"]
    for lang in ("python3", "typescript5"):
        docs += [root / lang / "README.md", root / lang / "tests" / "TestPlan.md"]
    return [doc for doc in docs if doc.exists()]


def markdown_cells(path: Path) -> list[dict]:
    return [c for c in json.loads(path.read_text())["cells"] if c["cell_type"] == "markdown"]


def title(path: Path) -> str:
    """The document's first heading, as plain text."""
    text = "".join(markdown_cells(path)[0]["source"]) if path.suffix == ".ipynb" else path.read_text()
    match = re.search(r"^# (.+)$", text, re.M)
    if not match:
        raise ValueError(f"{path} has no title")
    return re.sub(r"[`*]", "", match.group(1)).strip()


LANGUAGES = {"python3": "Python", "typescript5": "TypeScript"}


def language(path: Path, root: Path) -> str | None:
    return LANGUAGES.get(path.relative_to(root).parts[0])


def label(doc: Path, root: Path, here: Path) -> str:
    """A short name for a link to `doc` from `here`: the document's title, but for the documents each language has
    one of, which are named for it, the design document, which says so, and a notebook in the other language's series, which says which it is."""
    lang, parts = language(doc, root), doc.relative_to(root).parts
    if lang and parts[1:] == ("tutorials", "README.md"):
        return f"{lang} tutorial"
    if lang and parts[1:] == ("README.md",):
        return f"{lang} package"
    if lang and parts[1:] == ("tests", "TestPlan.md"):
        return f"{lang} test plan"
    name = title(doc)
    if doc.name in DESIGN_FIRST:
        return f"{name} design"
    return f"{name} ({lang})" if doc.suffix == ".ipynb" and lang != language(here, root) else name


def line(docs: list[Path], i: int, root: Path) -> str:
    here, home = docs[i], root / "README.md"
    link = lambda doc: Path(os.path.relpath(doc, here.parent)).as_posix()  # noqa: E731
    parts = []
    if i > 0:
        parts.append(f"[← {label(docs[i - 1], root, here)}]({link(docs[i - 1])})")
    if i > 1:
        parts.append(f"[Home]({link(home)})")
    if i + 1 < len(docs):
        parts.append(f"[{label(docs[i + 1], root, here)} →]({link(docs[i + 1])})")
    return f"{MARK}\n" + " · ".join(parts)


STRIP_TOP = re.compile(rf"\A{re.escape(MARK)}\n[^\n]*\n\n")
STRIP_BOTTOM = re.compile(rf"\n\n---\n\n{re.escape(MARK)}\n[^\n]*\n?\Z")


def write_markdown(path: Path, nav: str) -> None:
    text = STRIP_BOTTOM.sub("\n", STRIP_TOP.sub("", path.read_text()))
    path.write_text(f"{nav}\n\n{text.rstrip()}\n\n---\n\n{nav}\n")


def write_notebook(path: Path, nav: str) -> None:
    raw = path.read_text()
    notebook = json.loads(raw)
    def is_footer(cell: dict) -> bool:
        source = "".join(cell["source"])
        return cell["cell_type"] == "markdown" and source.startswith(MARK) and source.strip().count("\n") == 1

    cells = [c for c in notebook["cells"] if not is_footer(c)]
    first = next(c for c in cells if c["cell_type"] == "markdown")
    first["source"] = f"{nav}\n\n{STRIP_TOP.sub('', ''.join(first['source']))}".splitlines(keepends=True)
    footer = {"cell_type": "markdown", "metadata": {}, "source": f"{nav}".splitlines(keepends=True)}
    if any("id" in c for c in cells):
        footer["id"] = "nav"
    notebook["cells"] = [*cells, footer]
    text = json.dumps(notebook, indent=1, sort_keys=True, ensure_ascii=False)
    path.write_text(text + ("\n" if raw.endswith("\n") else ""))


def main(roots: list[str]) -> None:
    for root in map(Path, roots or [Path(__file__).resolve().parent.parent]):
        docs = order(root)
        for i, doc in enumerate(docs):
            nav = line(docs, i, root)
            (write_notebook if doc.suffix == ".ipynb" else write_markdown)(doc, nav)
        print(f"{root.name}: {len(docs)} documents")


if __name__ == "__main__":
    main(sys.argv[1:])
