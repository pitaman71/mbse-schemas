# schemas (Python)

Python implementation of the schemas framework. The design is in [`../Framework.md`](../Framework.md); the test plan is
in [`tests/TestPlan.md`](tests/TestPlan.md).

```sh
uv sync --all-extras
uv run pytest                                   # test notebooks
uv run python -m schemas.Examples.AddressBook   # an example
```
