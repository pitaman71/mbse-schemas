<!-- nav -->
[← Open-world modeling](OPEN_WORLD.md) · [Home](../README.md) · [Schema extension →](SCHEMA_EXTENSION.md)

# Parametrics : Revisited

```
class Symbols:
    positive, T, x = store.Symbols('positive', 'T', 'x')

class Domains:
    Bool = store.Expressions.Dialects.Basic.Bool
    Int32 = store.Expressions.Dialects.Basic.Int32

# positive(x: int) -> bool := (x + 1) > 0, x of any int schema, whatever its width
positive = store.Expressions.Framework.Function(lambda f: (f
    .name(Symbols.positive)
    .parameters([
        # use exactly one of { .domain, .value } adjacencies
        # to declare what the parameter denotes
        #
        # .domain declares a store.Expressions.Framework.Domain parameter
        # .value declares a store.Schemas.OfAny parameter
        #
        lambda p: p.name(Symbols.T).domain([store.Expressions.Framework.Domain.Schema])
    ])
    .formals([
        # this notation uses two shorthands: container and adjacency props
        lambda f: f.name(Symbols.x).domain([lambda d: d.as_param(Symbols.T)])
    ])
    .result([Domains.Bool])
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


# create a reference object that describes the substitution of
# all occurrences of formal parameter `T` by Int32

positive_int32 = store.Parameters.Bind(lambda b: b
    .target(positive)
    .formal(Symbols.T)
    .actual(Domains.Int32)
)

# Substitution can be lazily applied during evaluation
x=6
positive_int32(x) # True
x=-1
positive_int32(x) # False

```

Operations on function models are not defined yet. Any operation
which takes a callable function as an argument *must* be able to
interpret this binding directly. The operation's interpreter may
call a substitution transform before doing the "real work" if
"real work" doesn't handle substitutions itself.

---

<!-- nav -->
[← Open-world modeling](OPEN_WORLD.md) · [Home](../README.md) · [Schema extension →](SCHEMA_EXTENSION.md)
