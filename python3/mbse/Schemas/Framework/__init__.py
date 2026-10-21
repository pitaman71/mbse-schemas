"""mbse-schemas: neutral, language-independent schemas for interfaces and data models.

Objects, relations whose entries carry properties, unions and intersections. One schema value drives in-memory objects
(`Proxies`), JSON and YAML (`Plain`, `JSON`, `YAML`), validation (`Validators`) and comparison (`Comparison`). Schemas
are built in a store (`Builders.Store`), and a store is written as a log of mutations (`Mutations`); its writes are
mutation expressions over frames (`Transactions`), held apart from it until they commit (`Proposals`).

For AI agents: read `skill/SKILL.md` next to this file first. It says when to use this package, the practices that
prevent most mistakes, and which reference to load for a task. The design is in docs/FRAMEWORK.md at
https://github.com/pitaman71/mbse-schemas.
"""

from . import (JSON, YAML, Builders, Comparison, Errors, Mutations, Paths, Plain, Proposals, Proxies, Reachable, Readers,
               Schemas, Specs, Stores, Transactions, Validators, Visitors)

__all__ = ["Errors", "Schemas", "Builders", "Specs", "Visitors", "Readers", "Proxies", "Reachable", "Validators",
           "Comparison", "Plain", "JSON", "YAML", "Mutations", "Paths", "Stores", "Transactions",
           "Proposals"]
