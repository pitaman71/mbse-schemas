# mbse-schemas (Python)

Python implementation of the schemas framework. The design is in [`../docs/FRAMEWORK.md`](../docs/FRAMEWORK.md); the
test plan is in [`tests/TestPlan.md`](tests/TestPlan.md). New to the framework? Start with the tutorial,
[`tutorials/README.md`](tutorials/README.md): nine case studies, from a contact card to evolving schemas.

```sh
uv sync --all-extras
uv run pytest                                        # test notebooks and tutorials
uv run python -m mbse_schemas.Examples.AddressBook   # an example
```
