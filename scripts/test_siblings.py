"""Tests of siblings.py's workspaces, in scratch repositories with local remotes:

    python3 -m unittest discover -s scripts

Three repositories stand for the mbse ones: `lower` (no siblings), `middle` (pins lower) and `upper` (pins both), for
which siblings.py runs, as a dependent's scripts/siblings.py runs it. Standard library only, as siblings.py is.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import siblings

NAMES = ("lower", "middle", "upper")


def run(where: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(where), *args], capture_output=True, text=True, check=True).stdout.strip()


class Workspaces(unittest.TestCase):
    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name).resolve()
        environment = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "t",
                       "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
        patcher = unittest.mock.patch.dict(os.environ, environment)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.repos = self.root / "repos"
        for name in NAMES:
            remote = self.root / "remotes" / f"{name}.git"
            subprocess.run(["git", "init", "--quiet", "--bare", "--initial-branch=main", str(remote)], check=True)
            subprocess.run(["git", "clone", "--quiet", str(remote), str(self.repos / name)], check=True,
                           capture_output=True)
            self.write(name, "0.1.0", {"lower": [], "middle": ["lower"], "upper": ["lower", "middle"]}[name])
            run(self.repos / name, "add", "-A")
            run(self.repos / name, "commit", "--quiet", "-m", "first")
            run(self.repos / name, "tag", "--annotate", "v0.1.0", "--message", "Release 0.1.0")
            run(self.repos / name, "push", "--quiet", "--set-upstream", "origin", "main", "v0.1.0")
        for name in ("middle", "upper"):
            self.pin(self.repos / name)
        self.workspace = self.root / "worktrees" / "change"
        self.call(siblings.workspace, self.workspace, "change", ["lower", "middle"])

    def write(self, name: str, version: str, pinned: list[str], where: Path | None = None) -> None:
        """A repository's versions, and its siblings.json and requirements when it pins siblings."""
        where = where or self.repos / name
        (where / "python3").mkdir(exist_ok=True)
        (where / "typescript5").mkdir(exist_ok=True)
        requires = ", ".join(f'"{s}>=0.1.0,<0.2"' for s in pinned)
        (where / "python3" / "pyproject.toml").write_text(f'[project]\nversion = "{version}"\n'
                                                          f"dependencies = [{requires}]\n")
        (where / "typescript5" / "package.json").write_text(json.dumps({"version": version}))
        if pinned:
            entries = {s: {"repository": "", "version": "0.1.0"} for s in pinned}
            (where / "siblings.json").write_text(json.dumps(entries))

    def at(self, tree: Path):
        """siblings.py as run from `tree`."""
        return unittest.mock.patch.multiple(siblings, ROOT=tree, CONFIG=tree / "siblings.json",
                                            PYPROJECT=tree / "python3" / "pyproject.toml")

    def call(self, function, *args):
        with contextlib.redirect_stdout(io.StringIO()) as out, self.at(self.repos / "upper"):
            result = function(*args)
        self.output = out.getvalue()
        return result

    def pin(self, tree: Path) -> None:
        with contextlib.redirect_stdout(io.StringIO()), self.at(tree):
            siblings.pin()
        run(tree, "commit", "--quiet", "-am", "pin")

    def change(self, name: str, version: str | None = None) -> None:
        """A commit in the workspace's `name`, with a new version if given."""
        tree = self.workspace / name
        if version:
            self.write(name, version, json.loads((tree / "siblings.json").read_text()) if name != "lower" else [], tree)
        with open(tree / "CHANGE", "a") as out:  # each change is another line, so there is always one to commit
            out.write(f"{name}\n")
        run(tree, "add", "-A")
        run(tree, "commit", "--quiet", "-m", f"change {name}")

    def changed(self) -> None:
        """The change made in the workspace: lower and middle at 0.2.0, each dependent re-pinned."""
        self.change("lower", "0.2.0")
        self.pin(self.workspace / "middle")
        self.change("middle", "0.2.0")
        self.pin(self.workspace / "middle")
        self.pin(self.workspace / "upper")

    def heads(self) -> dict[str, str]:
        return {name: run(self.repos / name, "rev-parse", "HEAD") for name in NAMES}

    def refused(self, *messages: str) -> None:
        before = self.heads()
        with self.assertRaises(SystemExit) as raised:
            self.call(siblings.land, self.workspace, True)
        self.assertIn("nothing landed", str(raised.exception))
        for message in messages:
            self.assertIn(message, str(raised.exception))
        self.assertEqual(self.heads(), before)  # nothing changed, and the workspace is kept
        self.assertTrue(all((self.workspace / name).is_dir() for name in NAMES))

    def test_lands_siblings_first_tags_new_versions_and_pushes(self) -> None:
        self.changed()
        branch = {name: run(self.workspace / name, "rev-parse", "HEAD") for name in NAMES}
        self.assertEqual(self.call(siblings.land, self.workspace, True), 0)
        lines = self.output.splitlines()
        self.assertEqual([line.split(":")[0] for line in lines if "pushed" in line], ["lower", "middle", "upper"])
        self.assertIn("upper: main at", self.output)
        self.assertIn("v0.1.0 exists, so no release", self.output)  # upper kept its version
        self.assertEqual(self.heads(), branch)  # fast-forwarded: the pinned commits are the landed ones
        for name, tag in (("lower", "v0.2.0"), ("middle", "v0.2.0")):
            remote = self.root / "remotes" / f"{name}.git"
            self.assertEqual(run(remote, "rev-parse", "main"), branch[name])
            self.assertEqual(run(remote, "rev-parse", f"{tag}^{{commit}}"), branch[name])
        self.assertFalse(self.workspace.exists())
        self.assertEqual([run(self.repos / name, "branch", "--list", "change") for name in NAMES], ["", "", ""])

    def test_without_push_names_the_next_step(self) -> None:
        self.changed()
        self.call(siblings.land, self.workspace, False)
        self.assertIn("lower: deleted the branch change", self.output)
        self.assertTrue(self.output.endswith("next: python3 scripts/siblings.py push\n"))
        self.assertEqual(run(self.root / "remotes" / "lower.git", "rev-parse", "main"),
                         run(self.repos / "lower", "rev-parse", "HEAD~1"))  # nothing pushed

    def remote(self, name: str, ref: str) -> str:
        return run(self.root / "remotes" / f"{name}.git", "rev-parse", "--verify", "--quiet", ref)

    def test_push_after_landing_pushes_siblings_first_and_reruns_safely(self) -> None:
        self.changed()
        self.call(siblings.land, self.workspace, False)
        self.assertEqual(self.call(siblings.push), 0)
        self.assertEqual(self.output.splitlines(), ["lower: pushed main v0.2.0", "middle: pushed main v0.2.0",
                                                    "upper: pushed main"])
        for name in NAMES:
            self.assertEqual(self.remote(name, "main"), run(self.repos / name, "rev-parse", "HEAD"))
        self.assertEqual(self.remote("lower", "v0.2.0^{commit}"), run(self.repos / "lower", "rev-parse", "HEAD"))
        self.call(siblings.push)
        self.assertEqual(self.output.splitlines(), [f"{name}: up to date" for name in NAMES])

    def test_push_sets_the_upstream_of_a_new_branch(self) -> None:
        run(self.repos / "lower", "switch", "--quiet", "--create", "topic")
        self.call(siblings.push)
        self.assertIn("lower: pushed topic", self.output)
        self.assertEqual(run(self.repos / "lower", "rev-parse", "--abbrev-ref", "topic@{upstream}"), "origin/topic")

    def push_refused(self, *messages: str) -> None:
        before = {name: self.remote(name, "main") for name in NAMES}
        with self.assertRaises(SystemExit) as raised:
            self.call(siblings.push)
        self.assertIn("nothing pushed", str(raised.exception))
        for message in messages:
            self.assertIn(message, str(raised.exception))
        self.assertEqual({name: self.remote(name, "main") for name in NAMES}, before)

    def test_push_refuses_a_branch_behind_its_upstream(self) -> None:
        self.changed()
        self.call(siblings.land, self.workspace, False)
        self.moved("middle")
        self.push_refused("middle: main is behind origin/main; pull, retest and re-pin")

    def test_push_refuses_a_pin_the_sibling_does_not_contain(self) -> None:
        pinned = json.loads((self.repos / "upper" / "siblings.json").read_text())
        pinned["lower"]["commit"] = "0" * 40
        del pinned["middle"]["commit"]
        (self.repos / "upper" / "siblings.json").write_text(json.dumps(pinned))
        self.push_refused("upper: pins lower at 0000000, which lower's branch does not contain; run pin and commit",
                          "upper: pins middle at None")

    def test_push_refuses_a_checkout_not_on_a_branch(self) -> None:
        run(self.repos / "middle", "checkout", "--quiet", "--detach")
        self.push_refused(f"middle: the checkout {self.repos / 'middle'} is not on a branch")

    def test_land_and_push_only_this_repository(self) -> None:
        (self.repos / "lower" / "UNPUSHED").write_text("committed, not pushed")  # a detached sibling's checkout
        run(self.repos / "lower", "add", "-A")
        run(self.repos / "lower", "commit", "--quiet", "-m", "unpushed")
        alone = self.root / "worktrees" / "alone"
        self.call(siblings.workspace, alone, "alone", [])  # the siblings detached, so only upper lands
        (alone / "upper" / "NOTE").write_text("upper alone")
        run(alone / "upper", "add", "-A")
        run(alone / "upper", "commit", "--quiet", "-m", "alone")
        self.call(siblings.land, alone, True)
        self.assertEqual([line for line in self.output.splitlines() if "pushed" in line],  # middle's pin, from setUp
                         ["lower: pushed main", "middle: pushed main", "upper: pushed main"])

    def test_refuses_a_branch_that_does_not_fast_forward(self) -> None:
        self.changed()
        (self.repos / "lower" / "OTHER").write_text("parallel work")
        run(self.repos / "lower", "add", "-A")
        run(self.repos / "lower", "commit", "--quiet", "-m", "parallel")
        self.refused("lower: change does not fast-forward main")

    def moved(self, name: str) -> None:
        """A commit pushed to `name`'s remote from elsewhere, and fetched."""
        other = self.root / "other"
        subprocess.run(["git", "clone", "--quiet", str(self.root / "remotes" / f"{name}.git"), str(other)], check=True)
        (other / "OTHER").write_text("pushed elsewhere")
        run(other, "add", "-A")
        run(other, "commit", "--quiet", "-m", "elsewhere")
        run(other, "push", "--quiet")
        run(self.repos / name, "fetch", "--quiet")

    def test_refuses_when_the_remote_moved(self) -> None:
        self.changed()
        self.moved("middle")
        self.refused("middle: change does not fast-forward origin/main")

    def test_refuses_a_stale_pin(self) -> None:
        self.changed()
        self.change("lower")  # after middle and upper pinned it
        self.refused("middle: pins lower at")

    def test_refuses_changes_in_a_worktree_or_checkout(self) -> None:
        self.changed()
        (self.workspace / "middle" / "CHANGE").write_text("uncommitted")
        (self.repos / "lower" / "python3" / "pyproject.toml").write_text("uncommitted")
        self.refused("middle: has uncommitted changes",
                     f"lower: the checkout {self.repos / 'lower'} has uncommitted changes")

    def test_refuses_a_checkout_not_on_a_branch(self) -> None:
        self.changed()
        run(self.repos / "lower", "checkout", "--quiet", "--detach")
        self.refused(f"lower: the checkout {self.repos / 'lower'} is not on a branch")

    def test_untracked_files_in_a_checkout_are_left_alone(self) -> None:
        self.changed()
        (self.repos / "lower" / "NOTES").write_text("someone else's")
        self.assertEqual(self.call(siblings.land, self.workspace, False), 0)
        self.assertEqual((self.repos / "lower" / "NOTES").read_text(), "someone else's")

    def test_a_workspace_with_nothing_on_a_branch(self) -> None:
        detached = self.root / "worktrees" / "look"
        self.call(siblings.workspace, detached, None, [])
        with self.assertRaises(SystemExit) as raised:
            self.call(siblings.land, detached, False)
        self.assertIn("no worktree is on a branch: nothing to land", str(raised.exception))
        with self.assertRaises(SystemExit) as raised:
            self.call(siblings.land, self.root / "nowhere", False)
        self.assertIn("no worktrees here", str(raised.exception))

    def test_main_runs_a_command_for_the_dependent_at_root(self) -> None:
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(siblings.main(self.repos / "middle", ["check", "--strict"]), 0)
        lower = run(self.repos / "lower", "rev-parse", "--short", "HEAD")
        self.assertEqual(out.getvalue(), f"lower: 0.1.0, at its pinned commit {lower}\n")
        with contextlib.redirect_stdout(io.StringIO()):
            siblings.main(self.repos / "upper", ["workspace", str(self.root / "worktrees" / "more"), "--branch", "more",
                                                 "--edit", "middle", "--other"])
            self.assertEqual(run(self.root / "worktrees" / "more" / "middle", "branch", "--show-current"), "more")
            self.assertEqual(siblings.main(self.repos / "upper", ["remove", str(self.root / "worktrees" / "more")]), 0)
            self.assertEqual(siblings.main(self.repos / "upper", ["push"]), 0)
            siblings.main(self.repos / "upper", ["workspace", str(self.root / "worktrees" / "plain")])  # detached
        self.assertEqual(run(self.root / "worktrees" / "plain" / "upper", "branch", "--show-current"), "")
        with self.assertRaises(SystemExit) as raised:
            siblings.main(self.repos / "upper", ["help"])
        self.assertEqual(raised.exception.code, siblings.__doc__)

    def test_dependency_order(self) -> None:
        trees = {name: self.workspace / name for name in reversed(NAMES)}
        self.assertEqual(siblings.dependency_order(trees), ["lower", "middle", "upper"])
        (self.workspace / "lower" / "siblings.json").write_text(json.dumps({"upper": {}}))
        with self.assertRaises(SystemExit) as raised:
            siblings.dependency_order(trees)
        self.assertIn("its siblings pin it in a cycle", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
