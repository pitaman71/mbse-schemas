"""Dataclasses: translation between Python dataclasses and object schemas, through Python's syntax trees.

`FromDataclass.install(txn, module, *classes)` writes the schemas dataclasses describe into a transaction, as a written
install does, and is called within one (Store overhaul, Decided, 31):

    def install(txn):  # the order-entry schemas, read from their dataclasses
        return FromDataclass.install(txn.uid("models/1"), lambda m: m.name("models"), Order, Line)


    store.transaction(install)
    Order = store.registered("models.Order")

`module` writes the module (`Schemas.OfModule`) that holds them, found by its name or made; each class is an object
schema named after the module and the class (`models.Order`), defined in the module under the class's name, and each
relation the adapter infers is named after the module too. Each is a symbol of the install's upsert, found by its name,
else made: run again, the install writes nothing. `ToDataclass(schema)` returns a new dataclass describing an object
schema, named after the last part of the schema's name (or `ToDataclass(schema, name)`), and `ToDataclass.model(schemas)`
several, by name. Both directions go through `ast` trees and never through source text:

- `FromDataclass.ast(cls)` builds an `ast.ClassDef` from the class's fields and resolved type hints, not from its
  source. `FromDataclass` also reads such trees, so trees built by other tools work too.
- `ToDataclass.ast(schemas)` builds an `ast.Module` with one class definition per object schema, and
  `ToDataclass.compile(tree)` compiles it into the classes. The classes are compiled with postponed annotations
  (`from __future__ import annotations`), so they may refer to each other and to themselves.

Only types are translated, one flat class to one object schema:

- Fields map to properties, in order, including inherited fields. Field types map to scalar schemas: `int`, `float`,
  `str`, `bool` and `bytes`. A list of scalars (`list[str]`) maps to a property holding a container of them by an int
  index, dense; a dict of scalars by a scalar key (`dict[str, float]`) to one holding a container by that key, sparse
  for an int key (`dict[int, bool]`), so that its keys are not padded. Their elements may be lists and dicts of
  scalars in turn (`list[list[float]]`): containers nest.
- A container of dataclasses maps to an adjacency. The field `addresses: set[Address]` of `Contact` becomes the
  relation `ContactAddresses` (`models.ContactAddresses`, in the module `models`) with links `owner` and `item`, the
  adjacency `addresses` of `Contact` via `owner`, and the adjacency `contact_addresses` of `Address` via `item`.
  `list[Address]` adds the property `index: int` and `dict[K, Address]` the property `key: K`, each with
  `unique(item)`: the owner and the index or key determine the item. The element may be a union of dataclasses, and each gets the adjacency via `item`.
- An adjacency declares which object schemas may fill its link, so the element type of a container is found by
  reverse lookup: the object schemas that declare an adjacency via the relation's other link. `ToDataclass` writes a
  field for each adjacency via the first of its relation's two links; an adjacency via the second only declares
  which types may fill it.
- Defaults and mandatoriness are not translated: `FromDataclass` ignores field defaults, and `ToDataclass` writes
  fields without defaults.
- `ToDataclass` writes a container property as `list[E]` where it is dense by an int index, and as `dict[K, E]` where
  its index is any other scalar; a container by a value object index (a tensor) has no field type.
- Anything else raises `TypeError`: other collections, sets of scalars, containers of containers of dataclasses, a
  union in a dataclass field (it does
  not name its branches), and nested dataclasses and other type definitions (value objects, and union and
  intersection values, in a schema), which are handled separately.
"""

from __future__ import annotations

import __future__
import ast
import dataclasses
import keyword
import re
import types
import typing
from collections.abc import Iterator, Mapping
from typing import Any

from mbse.Schemas.Framework import Schemas

__all__ = ["FromDataclass", "ToDataclass"]

_SCALARS: dict[str, type] = {t.__name__: t for t in (int, float, str, bool, bytes)}
_SCALAR_NAMES = {int: "Int", float: "Float", str: "Str", bool: "Bool", bytes: "Bytes"}  # each a basic scalar, `S.OfInt`
_CONTAINERS = {"list": "list", "List": "list", "set": "set", "Set": "set", "frozenset": "set", "FrozenSet": "set",
               "dict": "dict", "Dict": "dict"}
_COLLECTIONS = frozenset({
    "tuple", "Tuple", "Sequence", "MutableSequence", "Mapping", "MutableMapping", "Iterable", "Collection",
    "AbstractSet", "MutableSet", *_CONTAINERS,
})
_NOT_FIELDS = frozenset({"ClassVar", "InitVar"})
_OWNER, _ITEM, _INDEX, _KEY = "owner", "item", "index", "key"
_RESERVED = frozenset({"dataclass", *_SCALARS, *_CONTAINERS})


def _identifier(value: str, what: str) -> str:
    if not value.isidentifier() or keyword.iskeyword(value):
        raise ValueError(f"{what} {value!r} is not a Python identifier")
    return value


def _name(node: ast.expr) -> str | None:
    """The name a `Name` or `Attribute` node refers to (`typing.List` is `List`), else None."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _load(name: str) -> ast.Name:
    return ast.Name(id=name, ctx=ast.Load())


def _either(items: list[ast.expr]) -> ast.expr:
    """`a | b | ...` of expression trees."""
    tree = items[0]
    for item in items[1:]:
        tree = ast.BinOp(left=tree, op=ast.BitOr(), right=item)
    return tree


def _alternatives(node: ast.expr) -> Iterator[ast.expr]:
    """The operands of `a | b | ...`, or the node itself."""
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        yield from _alternatives(node.left)
        yield from _alternatives(node.right)
    else:
        yield node


def _class_definition(name: str, body: list[ast.stmt]) -> ast.ClassDef:
    return ast.ClassDef(name=name, bases=[], keywords=[], body=body or [ast.Pass()],
                        decorator_list=[_load("dataclass")], type_params=[])


def _field(name: str, annotation: ast.expr) -> ast.AnnAssign:
    return ast.AnnAssign(target=ast.Name(id=name, ctx=ast.Store()), annotation=annotation, simple=1)


# --- From dataclasses ---


def _annotation(hint: Any) -> ast.expr:
    """An expression tree for a resolved type hint."""
    origin, args = typing.get_origin(hint), typing.get_args(hint)
    if origin is typing.Union or origin is types.UnionType:
        return _either([_annotation(a) for a in args])
    if origin is not None:
        items = [_annotation(a) for a in args]
        return ast.Subscript(value=_annotation(origin), slice=items[0] if len(items) == 1 else ast.Tuple(elts=items,
                             ctx=ast.Load()), ctx=ast.Load())
    if hint is None or hint is type(None):
        return ast.Constant(value=None)
    name = getattr(hint, "__name__", None) or getattr(hint, "_name", None)
    if isinstance(name, str):
        return _load(name)
    return ast.Constant(value=hint)  # e.g. a Literal's values


def _dataclasses_in(hint: Any) -> Iterator[type]:
    """The dataclasses a type hint mentions."""
    if isinstance(hint, type) and dataclasses.is_dataclass(hint):
        yield hint
    for arg in typing.get_args(hint):
        yield from _dataclasses_in(arg)


def _is_dataclass_decorator(node: ast.expr) -> bool:
    return _name(node.func if isinstance(node, ast.Call) else node) == "dataclass"


def _fields(tree: ast.ClassDef) -> Iterator[tuple[str, ast.expr]]:
    """The fields a class definition declares: annotated names, except `ClassVar` and `InitVar`."""
    if tree.bases:
        raise TypeError(f"{tree.name} has base classes; pass the class itself, so its inherited fields are included")
    if not any(_is_dataclass_decorator(d) for d in tree.decorator_list):
        raise TypeError(f"{tree.name} is not decorated with @dataclass")
    for statement in tree.body:
        if not isinstance(statement, ast.AnnAssign) or not isinstance(statement.target, ast.Name):
            continue  # methods, docstrings and plain assignments are not fields
        annotation = statement.annotation
        if _name(annotation.value if isinstance(annotation, ast.Subscript) else annotation) in _NOT_FIELDS:
            continue
        yield statement.target.id, annotation


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def _pascal(name: str) -> str:
    return "".join(part[:1].upper() + part[1:] for part in name.split("_"))


@dataclasses.dataclass
class _Container:
    """A property's container of scalars: its index's host type, its element (a host type or a `_Container`), and its
    layout, where it is not the default."""

    index: type
    element: Any
    layout: str | None = None


@dataclasses.dataclass
class _Object:
    """What a class becomes: its properties' schemas (a host type, or a `_Container`), and its adjacencies, each its
    relation's name and the link it is seen through."""

    properties: dict[str, Any] = dataclasses.field(default_factory=dict)
    adjacencies: dict[str, tuple[str, str]] = dataclasses.field(default_factory=dict)


@dataclasses.dataclass
class _Relation:
    """What a container of dataclasses becomes: a relation linking `owner` and `item`, with an `index` or `key` property
    and `unique(item)` where it has one."""

    properties: dict[str, type] = dataclasses.field(default_factory=dict)


class _Reader:
    """Reads what the classes of an install become, from their class definitions, by class name."""

    def __init__(self, trees: dict[str, ast.ClassDef]):
        self.trees = trees
        self.objects = {name: _Object() for name in trees}
        self.relations: dict[str, _Relation] = {}

    def read(self) -> _Reader:
        for name, tree in self.trees.items():
            for field, annotation in _fields(tree):
                self._field(name, field, annotation)
        for name, schema in self.objects.items():
            clashes = sorted(set(schema.properties) & set(schema.adjacencies))
            if clashes:
                raise ValueError(f"{name}: {clashes} would be both properties and adjacencies")
        return self

    def _field(self, owner: str, field: str, node: ast.expr) -> None:
        if isinstance(node, ast.Subscript):
            outer = _name(node.value)
            container = _container(node) if outer in _CONTAINERS else None
            if container is not None:
                self.objects[owner].properties[field] = container
                return
            if outer in _CONTAINERS:
                self._container(owner, field, _CONTAINERS[outer], outer, node.slice)
                return
            if outer in ("Optional", "Union"):
                raise TypeError(f"field {field!r}: a union needs a name per branch; unions are not translated")
            if outer in _COLLECTIONS:
                raise TypeError(f"field {field!r}: {outer} is not translated; container fields are list, set or dict "
                                "of dataclasses")
            raise TypeError(f"field {field!r}: {outer or 'this generic type'} is not translated")
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            raise TypeError(f"field {field!r}: a union needs a name per branch; unions are not translated")
        name = _name(node)
        if name in _SCALARS:
            self.objects[owner].properties[field] = _SCALARS[name]
        elif name in _COLLECTIONS:
            raise TypeError(f"field {field!r}: {name} needs a dataclass element type")
        elif name in self.trees:
            raise TypeError(f"field {field!r}: {name} is a nested dataclass; nesting is handled separately")
        elif name is None:
            raise TypeError(f"field {field!r}: the annotation is not a type")
        else:
            raise TypeError(f"field {field!r}: {name} is neither a scalar type nor a dataclass being translated")

    def _container(self, owner: str, field: str, shape: str, outer: str, node: ast.expr) -> None:
        properties: dict[str, type] = {}
        if shape == "dict":
            key, element = node.elts if isinstance(node, ast.Tuple) and len(node.elts) == 2 else (None, node)
            if key is None or _name(key) not in _SCALARS:
                raise TypeError(f"field {field!r}: {outer} needs a scalar key type and a dataclass value type")
            properties[_KEY] = _SCALARS[_name(key)]  # type: ignore[index]
        else:
            element = node
        if shape == "list":
            properties[_INDEX] = int
        nested = _name(element.value) if isinstance(element, ast.Subscript) else None
        if nested in _CONTAINERS:
            raise TypeError(f"field {field!r}: a {outer} of {nested}s of dataclasses is not translated; a container of "
                            "dataclasses is a field of its own")
        targets = [_name(n) for n in _alternatives(element)]
        for target in targets:
            if target not in self.trees:
                raise TypeError(f"field {field!r}: {outer} holds {target or 'something'} that is not a dataclass being "
                                "translated; a container field holds dataclasses, which become related objects")
        name = owner + _pascal(field)
        if name in self.relations or name in self.objects:
            raise ValueError(f"field {field!r}: the relation name {name!r} is already used")
        self.relations[name] = _Relation(properties)
        self._adjacency(owner, field, name, _OWNER)
        for target in dict.fromkeys(targets):
            self._adjacency(target, f"{_snake(owner)}_{field}", name, _ITEM)  # type: ignore[arg-type]

    def _adjacency(self, owner: str, name: str, relation: str, me: str) -> None:
        adjacencies = self.objects[owner].adjacencies
        if name in adjacencies:
            raise ValueError(f"{owner}: the adjacency {name!r} would be declared twice")
        adjacencies[name] = (relation, me)


def _scalar(node: ast.expr) -> type | None:
    return _SCALARS.get(_name(node))  # type: ignore[arg-type]


def _element(node: ast.expr) -> type | _Container | None:
    """A container's element type: a scalar, or a list or dict of them; None for anything else."""
    scalar = _scalar(node)
    if scalar is not None or not isinstance(node, ast.Subscript) or _name(node.value) not in _CONTAINERS:
        return scalar
    return _container(node)


def _container(node: ast.Subscript) -> _Container | None:
    """The container a list of scalars (by an int index, dense) or a dict of them by a scalar key (sparse for an int
    key) becomes, its elements scalars or such containers in turn; None for a container of anything else."""
    shape = _CONTAINERS[_name(node.value)]  # type: ignore[index]
    if shape == "list":
        element = _element(node.slice)
        return None if element is None else _Container(int, element)
    pair = node.slice.elts if shape == "dict" and isinstance(node.slice, ast.Tuple) else []
    key, element = (_scalar(pair[0]), _element(pair[1])) if len(pair) == 2 else (None, None)
    if key is None or element is None:
        return None
    return _Container(key, element, "sparse" if key is int else None)


def _schema(S: Any, shape: Any) -> Any:
    """A property's schema, in a spec: a basic scalar (`S.OfInt`), or a container defined where it is linked."""
    if isinstance(shape, type):
        return getattr(S, "Of" + _SCALAR_NAMES[shape])

    def container(c: Any) -> Any:
        c = c.index([_schema(S, shape.index)]).element([_schema(S, shape.element)])
        return c if shape.layout is None else c.layout(shape.layout)

    return S.OfContainer(container)


class _FromDataclass:
    """`FromDataclass.install(txn, module, *classes)`: an install of the schemas dataclasses describe."""

    def install(self, txn: Any, module: Any, *sources: type | ast.ClassDef) -> Any:
        """Writes the schemas the given dataclasses or class definitions describe, and every dataclass their container
        fields hold, into a transaction: `txn.mutations([...])`, as a written install returns, called within one's
        module-scope `install(txn)` with the transaction it is given, its uid set by the caller. Its one upsert's
        symbols are the module, a `Schemas.OfModule` that `module` writes (`lambda m: m.name("models")`), found by its
        name or made; each class, a `Schemas.OfObject` named `<module>.<class>`, defined in the module under its class
        name; and each relation a container field becomes, a `Schemas.OfRelation` named `<module>.<Class><Field>`.
        Run again, it writes nothing."""
        store = getattr(txn, "_store", None)
        if store is None or not callable(getattr(txn, "mutations", None)):
            raise TypeError(f"FromDataclass.install takes the transaction an install is given, got {type(txn).__name__}")
        path = self._module(module)
        reader = self._read(sources)
        S = store.Schemas
        named = {name: f"{path}.{name}" for name in (*reader.objects, *reader.relations)}  # each symbol, by its name

        def of_module(_: Any) -> Any:
            m = getattr(_, path)
            module(m)
            return m.schemas([lambda t, name=name: t.name(name).schema([getattr(_, named[name])])
                              for name in reader.objects])

        def of_class(name: str, schema: _Object) -> Any:
            def spec(_: Any) -> Any:
                o = getattr(_, named[name]).name(named[name]).ref(True)
                if schema.properties:
                    o = o.properties({field: _schema(S, shape) for field, shape in schema.properties.items()})
                if schema.adjacencies:
                    o = o.adjacencies({field: lambda a, r=relation, me=me: a.relation([getattr(_, named[r])]).me(me)
                                       for field, (relation, me) in schema.adjacencies.items()})
                return o
            return spec

        def of_relation(name: str, relation: _Relation) -> Any:
            def spec(_: Any) -> Any:
                r = getattr(_, named[name]).name(named[name]).links([lambda t: t.name(_OWNER), lambda t: t.name(_ITEM)])
                if relation.properties:
                    r = r.properties({key: _schema(S, scalar) for key, scalar in relation.properties.items()}).uniques(_ITEM)
                return r
            return spec

        symbols = {path: S.OfModule, **{named[name]: S.OfObject for name in reader.objects},
                   **{named[name]: S.OfRelation for name in reader.relations}}
        items = [of_module, *[of_class(n, o) for n, o in reader.objects.items()],
                 *[of_relation(n, r) for n, r in reader.relations.items()]]
        return txn.mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p.symbols(symbols).spec(items)]))])

    @staticmethod
    def _module(module: Any) -> str:
        """The path of the module that `module` writes, which names its schemas: what its callback gives `name`."""
        from mbse.Schemas.Framework import Builders

        if not callable(module) or isinstance(module, type):
            raise TypeError("FromDataclass.install takes the module as a callback writing it, "
                            f"lambda m: m.name(\"models\"); got {module!r}")
        probe = Builders.ModuleBuilder(None, True, None)  # outside any store: read, never created
        module(probe)
        path = probe.name.get()
        if not isinstance(path, str) or not Schemas._DOTTED.match(path):
            raise ValueError(f"the module's name is its path, a dotted name its schemas' names start with; got {path!r}")
        return path

    def _read(self, sources: tuple[type | ast.ClassDef, ...]) -> _Reader:
        """What the given dataclasses or class definitions become, and every dataclass their container fields hold."""
        if not sources:
            raise TypeError("FromDataclass.install takes at least one dataclass")
        namespace: dict[str, type] = {}

        def known(cls: type) -> None:
            if namespace.setdefault(cls.__name__, cls) is not cls:
                raise ValueError(f"two classes are named {cls.__name__!r}")

        for source in sources:
            if isinstance(source, type):
                known(source)
        trees: dict[str, ast.ClassDef] = {}
        pending, queued = list(sources), set(sources)
        while pending:
            source = pending.pop(0)
            if isinstance(source, ast.ClassDef):
                tree = source
            else:
                tree = self.ast(source, namespace)
                for hint in typing.get_type_hints(source, localns=namespace).values():
                    for found in _dataclasses_in(hint):
                        known(found)
                        if found not in queued:
                            pending.append(found)
                            queued.add(found)
            if trees.setdefault(tree.name, tree) is not tree:
                raise ValueError(f"two classes are named {tree.name!r}")
        return _Reader(trees).read()

    @staticmethod
    def ast(cls: type, namespace: Mapping[str, type] | None = None) -> ast.ClassDef:
        """The class definition a dataclass's fields describe, with each field's resolved type as its annotation.
        Inherited fields are included, so the tree has no base classes. `namespace` resolves names that the class's
        own module does not define, e.g. of classes `ToDataclass` made."""
        if not isinstance(cls, type):
            raise TypeError(f"expected a dataclass or an ast.ClassDef, got {type(cls).__name__}")
        if not dataclasses.is_dataclass(cls):
            raise TypeError(f"{cls.__name__} is not a dataclass")
        hints = typing.get_type_hints(cls, localns=dict(namespace or {}))
        return _class_definition(cls.__name__, [_field(f.name, _annotation(hints[f.name])) for f in dataclasses.fields(cls)])


FromDataclass = _FromDataclass()


# --- To dataclasses ---


def _type_annotation(prop: str, schema: Any) -> ast.expr:
    """An expression tree for the type of a property's values."""
    if isinstance(schema, Schemas.OfScalar.Data):
        return _load(schema.host().__name__)
    if isinstance(schema, Schemas.OfContainer.Data):
        index, element = schema.index, _type_annotation(prop, schema.element)
        if not isinstance(index, Schemas.OfScalar.Data):
            raise TypeError(f"property {prop!r} holds a container by a value object index; it has no field type")
        if index.host() is int and schema.arrangement == "dense":
            return ast.Subscript(value=_load("list"), slice=element, ctx=ast.Load())
        pair = ast.Tuple(elts=[_load(index.host().__name__), element], ctx=ast.Load())
        return ast.Subscript(value=_load("dict"), slice=pair, ctx=ast.Load())
    noun = ("a union value" if isinstance(schema, Schemas.OfUnion.Data) else
            "an intersection value" if isinstance(schema, Schemas.OfIntersection.Data) else "a value object")
    raise TypeError(f"property {prop!r} holds {noun}; nested dataclasses are handled separately")


def _container_annotation(adjacency: Schemas.OfAdjacency.Data, objects: Mapping[str, Schemas.OfObject.Data]
                          ) -> ast.expr | None:
    """The container type an adjacency is viewed as, or None for an adjacency that only declares a link's types."""
    relation = adjacency.relation
    if relation is None or len(relation.entry.links) != 2:
        raise TypeError(f"adjacency {adjacency.name!r}: only a relation with two links has a container form")
    first, other = relation.entry.links
    if adjacency.me != first:
        return None
    targets = [name for name, schema in objects.items()
               if any(a.relation is relation and a.me == other for a in schema.adjacencies.values())]
    if not targets:
        raise TypeError(f"adjacency {adjacency.name!r}: no object schema declares an adjacency via {other!r}, so the "
                        "element type is unknown")
    element = _either([_load(t) for t in targets])
    if not relation.entry.properties:
        return ast.Subscript(value=_load("set"), slice=element, ctx=ast.Load())
    (key, key_property), *more = relation.entry.properties.items()
    key_schema = key_property.schema
    if more or relation.uniques != (frozenset({other}),) or not isinstance(key_schema, Schemas.OfScalar.Data):
        raise TypeError(f"adjacency {adjacency.name!r}: only one scalar property and unique({other!r}) have a "
                        "container form")
    if key == _INDEX and key_schema.host() is int:
        return ast.Subscript(value=_load("list"), slice=element, ctx=ast.Load())
    return ast.Subscript(value=_load("dict"), slice=ast.Tuple(elts=[_load(key_schema.host().__name__), element],
                         ctx=ast.Load()), ctx=ast.Load())


class _ToDataclass:
    """`ToDataclass(schema)`: a new dataclass describing an object schema, named after the last part of its name, or
    `ToDataclass(schema, name)`."""

    def __call__(self, schema: Schemas.OfObject.Data, name: str | None = None) -> type:
        if not isinstance(schema, Schemas.OfObject.Data):
            raise TypeError(f"expected an object schema, got {type(schema).__name__}")
        if name is None and schema.name is None:
            raise ValueError("an unnamed schema needs a class name: ToDataclass(schema, name)")
        name = name if name is not None else schema.name.rsplit(".", 1)[-1]
        return self.model({name: schema})[name]

    def model(self, schemas: Mapping[str, Any]) -> dict[str, type]:
        """A dataclass for each object schema, by name. Relation schemas are skipped, so the schemas an install
        of `FromDataclass.install` defines can be passed as they are."""
        return self.compile(self.ast(schemas))

    @staticmethod
    def ast(schemas: Mapping[str, Any]) -> ast.Module:
        """A module with one `@dataclass` class definition per object schema: one field per property, in order, then
        one per adjacency with a container form."""
        objects: dict[str, Schemas.OfObject.Data] = {}
        for name, schema in schemas.items():
            if isinstance(schema, Schemas.OfObject.Data):
                if name in _RESERVED:
                    raise ValueError(f"class name {name!r} is reserved")
                objects[_identifier(name, "class name")] = schema
            elif not isinstance(schema, Schemas.OfRelation.Data):
                raise TypeError(f"{name!r}: expected an object or relation schema, got {type(schema).__name__}")
        body: list[ast.stmt] = []
        for name, schema in objects.items():
            fields = [_field(_identifier(p, "property"), _type_annotation(p, prop.schema)) for p, prop in schema.properties.items()]
            for adjacency in schema.adjacencies.values():
                annotation = _container_annotation(adjacency, objects)
                if annotation is not None:
                    fields.append(_field(_identifier(adjacency.name, "adjacency"), annotation))
            body.append(_class_definition(name, fields))
        return ast.fix_missing_locations(ast.Module(body=body, type_ignores=[]))

    @staticmethod
    def compile(tree: ast.Module) -> dict[str, type]:
        """Compiles a module of class definitions, as `ToDataclass.ast` builds, and returns the classes by name."""
        if not isinstance(tree, ast.Module) or not tree.body or not all(isinstance(s, ast.ClassDef) for s in tree.body):
            raise ValueError("expected an ast.Module of class definitions")
        namespace: dict[str, Any] = {"__name__": __name__, "dataclass": dataclasses.dataclass}
        # Postponed annotations let the classes refer to each other; dont_inherit keeps this module's flags out.
        code = compile(ast.fix_missing_locations(tree), "<ToDataclass>", "exec",
                       flags=__future__.annotations.compiler_flag, dont_inherit=True)
        exec(code, namespace)
        return {s.name: namespace[s.name] for s in tree.body}  # type: ignore[attr-defined]


ToDataclass = _ToDataclass()
