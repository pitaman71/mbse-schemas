# Why the mbse repositories exist

The MBSE repositories are a major step towards reframing software, hardware, firmware, and cloud development through
executable specifications: closing the gap between human intent, docs, and component implementations in source
languages as diverse as TypeScript and SystemVerilog, C++ and Python. They also facilitate incremental formalization of
that intent throughout the development cycle. They support automated generation of production-level source code that is
both correct by construction and verified by tests. Every stage and every step of modeling, iterative formalization,
documentation and coding keeps humans and AI agents in the loop.

## How each repository contributes

| Repository | Its part of an executable specification |
|---|---|
| [mbse-schemas](https://github.com/pitaman71/mbse-schemas) | The structure: objects, relationships whose entries carry properties, and their cardinalities, as one neutral schema that drives in-memory objects, JSON and YAML, validation, and generated bindings in each target language |
| [mbse-expressions](https://github.com/pitaman71/mbse-expressions) | The rules: constraints, derived values and the conditions an interface promises, as data that every language evaluates alike and that translates into each implementation language, from Excel and MATLAB to C and SystemVerilog |
| [mbse-patterns](https://github.com/pitaman71/mbse-patterns) | The rules about populations of data: predicates that check implementations' data, find it, and generate realistic test data, so the specification is also the test oracle and the fixture |
| [mbse-programs](https://github.com/pitaman71/mbse-programs) | The code: target languages' complete syntax trees as data (C and C++, Python and TypeScript so far), so that generators build and rewrite real programs and print them as production source |

Each has two equivalent implementations, in Python and TypeScript, that write byte-identical JSON, and an `AGENTS.md`
for the AI agents that work in it. Each builds on mbse-schemas, and lives beside the others as a sibling checkout.
