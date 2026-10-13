"""Notebook checks shared by tests/ and tutorials/.

nbmake fails a notebook when a cell raises, but some failures reach it only as printed text: IPython renders an
`ExceptionGroup` (Hypothesis raises one when it finds several failures) as stderr output rather than as an error, so
the notebook passed. A notebook therefore also fails when any of its outputs holds a traceback.
"""

from __future__ import annotations

from typing import Any

from nbmake import nb_run
from nbmake.nb_result import NotebookError, NotebookResult

_execute = nb_run.NotebookRun.execute


def _traceback(nb: Any) -> tuple[int, str] | None:
    """The first output holding a traceback, as its cell's index and its text."""
    for index, cell in enumerate(nb.cells):
        for output in cell.get("outputs", []):
            text = "".join(output.get("text", "")) + "".join(output.get("traceback", []))
            if output.get("output_type") == "error" or "Traceback (most recent call last)" in text:
                return index, text
    return None


def _execute_checked(self: Any) -> NotebookResult:
    result = _execute(self)
    found = None if result.error is not None else _traceback(result.nb)
    if found is not None:
        index, text = found
        result.error = NotebookError(summary=f"a traceback in the output of cell {index}", trace=text,
                                     failing_cell_index=index)
    return result


nb_run.NotebookRun.execute = _execute_checked  # type: ignore[method-assign]
