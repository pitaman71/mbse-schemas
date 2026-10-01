"""mbse-schemas: neutral, language-independent schemas for interfaces and data models.

Objects, relations whose entries carry properties, unions and intersections. One schema value drives in-memory objects
(`Proxies`), JSON and YAML (`Plain`, `JSON`, `YAML`), validation (`Validators`) and comparison (`Comparison`).

For AI agents: read `skill/SKILL.md` next to this file first. It says when to use this package, the rules that prevent
most mistakes, and which reference to load for a task. The design is in docs/FRAMEWORK.md at
https://github.com/pitaman71/mbse-schemas.
"""

from . import JSON, YAML, Bindings, Comparison, Errors, Modules, Plain, Proxies, Reachable, Schemas, Validators, Visitors

__all__ = ["Errors", "Schemas", "Visitors", "Proxies", "Reachable", "Validators", "Comparison", "Plain", "JSON", "YAML",
           "Modules", "Bindings"]
