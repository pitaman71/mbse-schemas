<!-- nav -->
[← Open-world modeling](OPEN_WORLD.md) · [Home](../README.md) · [Schema extension →](SCHEMA_EXTENSION.md)

# Parametrics : Revisited

```
class Symbols:
    positive, T, X = store.Symbols('T', 'x', 'positive')

BoolDomain = store.Expressions.Dialects.Basic.BoolDomain
# positive(x: int) -> bool := (x + 1) > 0, x of any int schema, whatever its width
positive = store.Expressions.Framework.Function(lambda f: (
    f
    .name(Symbols.positive)
    .parameters([
        lambda p: p.name(symbols.T).domain([Expressions.Framework.Domain.Schema])
    ])
    .formals([
        # uses two shorthands: container and adjacency props
        lambda f: f.name(symbols.x).domain([lambda d: d.as_param(symbols.T)])
    ])
    .result([BoolDomain])
    .body([
        # body is a property containing terms
        # unions can and should use `as_` for branch/variant names
        lambda t: t.as_call(lambda lt: (lt
            .function("lt")
            .arguments([
                lambda a: a.as_literal(0),
                lambda a: a.as_call(lambda add: (add
                    .function("add")
                    .arguments([
                        lambda b: b.as_variable(Symbols.x),
                        lambda b: b.as_literal(1),
                    ])
                )),
            ])
        ))
    ])
))

# creates a new function definition, again as a reference object,
# with all occurrences of parameter `T` replaced
positive_int32 = store.Parameters.Transform(lambda x: x
    .target(Symbols.positive)
    .replace(lambda a: a.as_param(Symbols.T))
    .with(lambda a: a.as_domain(Symbols.T))
)
```

---

<!-- nav -->
[← Open-world modeling](OPEN_WORLD.md) · [Home](../README.md) · [Schema extension →](SCHEMA_EXTENSION.md)
