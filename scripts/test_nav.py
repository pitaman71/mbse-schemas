"""Tests of nav.py: python3 -m unittest discover -s scripts"""

import json
import tempfile
import unittest
from pathlib import Path

import nav


def notebook(title: str) -> str:
    cells = [{"cell_type": "markdown", "id": "a", "metadata": {}, "source": [f"# {title}\n", "\n", "Text."]},
             {"cell_type": "code", "execution_count": None, "id": "b", "metadata": {}, "outputs": [], "source": ["1"]}]
    return json.dumps({"cells": cells, "metadata": {}, "nbformat": 4, "nbformat_minor": 5}, indent=1, sort_keys=True) + "\n"


class Nav(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp()) / "repo"
        files = {"README.md": "# repo\n\nWhy.\n", "MBSE.md": "# Why\n", "docs/EQUIVALENCE.md": "# Equivalence\n",
                 "docs/FRAMEWORK.md": "# Framework\n", "python3/tutorials/README.md": "# Tutorial\n",
                 "python3/tutorials/01_One.ipynb": notebook("1 · One"), "typescript5/tutorials/README.md": "# Tutorial\n",
                 "typescript5/tutorials/01_One.ipynb": notebook("1 · One"), "python3/tests/TestPlan.md": "# Plan\n",
                 "AGENTS.md": "# Agents\n"}
        for name, text in files.items():
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            (self.root / name).write_text(text)

    def test_order_labels_and_idempotence(self) -> None:
        nav.main([str(self.root)])
        once = {p: p.read_text() for p in self.root.rglob("*") if p.is_file()}
        nav.main([str(self.root)])
        self.assertEqual(once, {p: p.read_text() for p in self.root.rglob("*") if p.is_file()})
        self.assertEqual([p.relative_to(self.root).as_posix() for p in nav.order(self.root)], [
            "README.md", "MBSE.md", "python3/tutorials/README.md", "python3/tutorials/01_One.ipynb",
            "typescript5/tutorials/README.md", "typescript5/tutorials/01_One.ipynb", "docs/FRAMEWORK.md",
            "docs/EQUIVALENCE.md", "python3/tests/TestPlan.md"])
        readme = (self.root / "README.md").read_text()
        self.assertTrue(readme.startswith("<!-- nav -->\n[Why →](MBSE.md)\n\n# repo\n"))
        self.assertTrue(readme.endswith("Why.\n\n---\n\n<!-- nav -->\n[Why →](MBSE.md)\n"))
        self.assertIn("[← repo](README.md) · [Python tutorial →](python3/tutorials/README.md)",
                      (self.root / "MBSE.md").read_text())  # no Home beside a previous that is home
        cells = json.loads((self.root / "typescript5/tutorials/README.md").read_text() and
                           (self.root / "python3/tutorials/01_One.ipynb").read_text())["cells"]
        self.assertEqual(len(cells), 3)
        self.assertEqual("".join(cells[-1]["source"]), "<!-- nav -->\n[← Python tutorial](README.md) · "
                         "[Home](../../README.md) · [TypeScript tutorial →](../../typescript5/tutorials/README.md)")
        self.assertIn("[← 1 · One (Python)](../../python3/tutorials/01_One.ipynb)",
                      (self.root / "typescript5/tutorials/README.md").read_text())
        self.assertIn("[Framework design →](../../docs/FRAMEWORK.md)",
                      "".join(json.loads((self.root / "typescript5/tutorials/01_One.ipynb").read_text())["cells"][-1]["source"]))
        self.assertEqual((self.root / "AGENTS.md").read_text(), "# Agents\n")  # agent-facing files are left alone

    def test_a_document_without_a_title(self) -> None:
        (self.root / "MBSE.md").write_text("No title.\n")
        with self.assertRaisesRegex(ValueError, "has no title"):
            nav.main([str(self.root)])


if __name__ == "__main__":
    unittest.main()
