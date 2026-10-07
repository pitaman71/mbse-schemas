"""Reflection: schemas as the objects of a store.

A module holds schemas as value objects, nested (`Modules`), which is how they are written and read. Reflection binds the
schema data classes themselves to reference object schemas, as mbse-expressions binds its terms (see `Bindings`), so
that a store's objects are the schemas: each kind of schema, and each property, branch or part, parameter and adjacency,
is an object of its own. `store(schemas)` makes such a store, whose singleton catalog lists the schemas; what the catalog
reaches is the store's data, so predicates and queries (mbse-patterns) match schemas as they match any objects, and
transforms rewrite them. There is nothing to build from schemas or to read back: the objects are the schemas.

- **Kinds and elements.** `Schemas.Native`, `Schemas.Object`, `Schemas.Union`, `Schemas.Intersection`,
  `Schemas.Indexed`, `Schemas.Apply` and `Schemas.Relation` are the kinds' meta-schemas; `Schemas.Property`,
  `Schemas.Member` (a union's branch, an intersection's part), `Schemas.Parameter` and `Schemas.Adjacency` the
  elements'. Each has its natives as properties (a native's token as `format` and `token`), and an extent, a width's
  terms and an application's arguments as values, in their module form.
- **Relations.** `Schemas.Members` links an `owner` to each `member` it holds, with the member's `role` (`parameters`,
  `properties`, `branches`, `parts`, `adjacencies`) and `index`; `Schemas.Types` links a `user` to each `type` it
  refers to, with its `role` (`type`, `item`, `key`, `of`, `relation`); `Schemas.Listed` links the catalog to each
  schema, with its `index`. Each is written from the side that holds it (`members`, `types`, `schemas`); the other
  sides (`owners`, `users`, `listed`) are implied.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

from . import Bindings, Modules, Schemas

__all__ = ["CATALOG", "Catalog", "Members", "Types", "Listed", "META", "store"]

CATALOG = "Schemas.Catalog"


def _native(name: str, kind: type = str) -> Schemas.OfProperty.Spec:
    return lambda p: p.name(name).of(lambda t: t.as_native(kind))


def _typed(name: str, schema: Any) -> Schemas.OfProperty.Spec:
    return lambda p: p.name(name).of(schema)


Members = Schemas.OfRelation.Builder().name("Schemas.Members").links("owner", "member").properties(
    _native("role"), _native("index", int)).unique("member").create()
Types = Schemas.OfRelation.Builder().name("Schemas.Types").links("user", "type").properties(
    _native("role")).unique("type").create()
Listed = Schemas.OfRelation.Builder().name("Schemas.Listed").links("catalog", "schema").properties(
    _native("index", int)).unique("schema").create()

_MEMBERS = lambda r: r.name("members").of(Members).me("owner")  # noqa: E731
_OWNERS = lambda r: r.name("owners").of(Members).me("member")  # noqa: E731
_TYPES = lambda r: r.name("types").of(Types).me("user")  # noqa: E731
_USERS = lambda r: r.name("users").of(Types).me("type")  # noqa: E731
_LISTED = lambda r: r.name("listed").of(Listed).me("schema")  # noqa: E731
_KIND = (_MEMBERS, _USERS, _LISTED)
_ELEMENT = (_TYPES, _OWNERS)


def _meta(name: str, properties: Iterable[Any], relations: Iterable[Any]) -> Schemas.OfObject.Data:
    return Schemas.OfObject.Builder().name(name).ref().properties(*properties).relations(*relations).create()


_named = (_native("name"), _native("description"))
_value = lambda name, kind: _typed(name, kind.Schema.properties[name].type)  # noqa: E731
META: dict[type, Schemas.OfObject.Data] = {
    Schemas.OfNative.Data: _meta("Schemas.Native", (*_named, _native("format"), _native("token"), _native("bits", int),
                                                    _native("bytes", int), _value("terms", Schemas.OfNative)), _KIND),
    Schemas.OfObject.Data: _meta("Schemas.Object", (*_named, _native("singleton"), _native("ref", bool)), _KIND),
    Schemas.OfUnion.Data: _meta("Schemas.Union", _named, _KIND),
    Schemas.OfIntersection.Data: _meta("Schemas.Intersection", _named, _KIND),
    Schemas.OfIndexed.Data: _meta("Schemas.Indexed", (*_named, _value("extent", Schemas.OfIndexed)), (*_KIND, _TYPES)),
    Schemas.OfApply.Data: _meta("Schemas.Apply", (*_named, _value("arguments", Schemas.OfApply)), (*_KIND, _TYPES)),
    Schemas.OfRelation.Data: _meta("Schemas.Relation", (*_named, _value("links", Schemas.OfRelation),
                                                        _value("uniques", Schemas.OfRelation)), _KIND),
    Schemas.OfProperty.Data: _meta("Schemas.Property", _named, _ELEMENT),
    Schemas.OfUnion.Branch: _meta("Schemas.Member", _named, _ELEMENT),
    Schemas.OfParameter.Data: _meta("Schemas.Parameter", _named, _ELEMENT),
    Schemas.OfAdjacency.Data: _meta("Schemas.Adjacency", (*_named, _native("me")), _ELEMENT),
}
"""Each schema data class's meta-schema, as a store of schemas registers it."""


# --- Reading: an instance's state ---


def _present(**values: Any) -> dict[str, Any]:
    return {name: value for name, value in values.items() if value is not None}


def _members(**groups: Iterable[Any]) -> list[Bindings.Entry]:
    """The entries of `members`: each group's members, in order, by role."""
    return [Bindings.Entry({"member": member}, {"role": role, "index": index})
            for role, members in groups.items() for index, member in enumerate(members)]


def _types(**types: Any) -> list[Bindings.Entry]:
    """The entries of `types`: each type referred to, by role."""
    return [Bindings.Entry({"type": type_}, {"role": role}) for role, type_ in types.items() if type_ is not None]


def _read(schema: Any) -> Bindings.State:
    """A schema's or an element's state: its natives, its values in their module form, its members and types."""
    named = {"name": schema.name, "description": schema.description}
    parameters = getattr(schema, "parameters", {}).values()
    if isinstance(schema, Schemas.OfNative.Data):
        if not isinstance(schema.token, Schemas.OfNative.Token):
            raise TypeError(f"unsupported native type {schema.token!r}")
        values = _present(**named, format=schema.token.format, token=schema.token.name, bits=Modules._literal(schema.bits),
                          bytes=Modules._literal(schema.bytes), terms=Modules._terms(bits=schema.bits, bytes=schema.bytes))
        return Bindings.State(values, {"members": _members(parameters=parameters)})
    if isinstance(schema, Schemas.OfObject.Data):
        values = _present(**named, singleton=schema.singleton, ref=schema.ref or None)
        members = _members(parameters=parameters, properties=schema.properties.values(),
                           adjacencies=schema.adjacencies.values())
        return Bindings.State(values, {"members": members})
    if isinstance(schema, (Schemas.OfUnion.Data, Schemas.OfIntersection.Data)):
        role = "branches" if isinstance(schema, Schemas.OfUnion.Data) else "parts"
        return Bindings.State(_present(**named), {"members": _members(parameters=parameters, **{role: schema.properties.values()})})
    if isinstance(schema, Schemas.OfIndexed.Data):
        values = _present(**named, extent=Modules._extent(schema.extent))
        return Bindings.State(values, {"members": _members(parameters=parameters),
                                       "types": _types(item=schema.item, key=schema.key)})
    if isinstance(schema, Schemas.OfApply.Data):
        values = _present(**named, arguments=Modules._arguments(schema.arguments) or None)
        return Bindings.State(values, {"members": _members(parameters=parameters), "types": _types(of=schema.of)})
    if isinstance(schema, Schemas.OfRelation.Data):
        values = _present(**named, links=list(schema.links),
                          uniques=[sorted(unique) for unique in schema.uniques] or None)
        return Bindings.State(values, {"members": _members(parameters=parameters, properties=schema.properties.values())})
    if isinstance(schema, Schemas.OfAdjacency.Data):
        return Bindings.State(_present(**named, me=schema.me), {"types": _types(relation=schema.relation)})
    return Bindings.State(_present(**named), {"types": _types(type=schema.type)})  # a property, member or parameter


# --- Making: an instance from a state ---


def _grouped(state: Bindings.State) -> dict[str, list[Any]]:
    """The members of a state, by role, each role's in order of index."""
    groups: dict[str, dict[int, Any]] = {}
    for entry in state.entries.get("members", []):
        groups.setdefault(entry.properties["role"], {})[entry.properties["index"]] = entry.links["member"]
    return {role: [slots[index] for index in sorted(slots)] for role, slots in groups.items()}


def _typed_by(state: Bindings.State) -> dict[str, Any]:
    return {entry.properties.get("role"): entry.links["type"] for entry in state.entries.get("types", [])}


def _by_name(members: Iterable[Any]) -> dict[str, Any]:
    return {member.name: member for member in members}


_READER = Modules._Reader(None, [])  # type: ignore[arg-type]  # reads values' module forms, which name no schema


def _make(data: type) -> Callable[[Bindings.State], Any]:
    def make(state: Bindings.State) -> Any:
        values, members, types = state.values, _grouped(state), _typed_by(state)
        named = {"name": values.get("name"), "description": values.get("description")}
        parameters = _by_name(members.get("parameters", []))
        if data is Schemas.OfNative.Data:
            token = Schemas.OfNative.Token(values["format"], values["token"])
            return data(token, _READER.slot(values, "bits"), _READER.slot(values, "bytes"), parameters=parameters, **named)
        if data is Schemas.OfObject.Data:
            return data(_by_name(members.get("properties", [])), _by_name(members.get("adjacencies", [])),
                        values.get("singleton"), values.get("ref", False), parameters=parameters, **named)
        if data is Schemas.OfUnion.Data:
            return data(tuple(members.get("branches", [])), parameters=parameters, **named)
        if data is Schemas.OfIntersection.Data:
            return data(tuple(members.get("parts", [])), parameters=parameters, **named)
        if data is Schemas.OfIndexed.Data:
            return data(types.get("item"), types.get("key"), _READER.extent(values.get("extent")), parameters=parameters,
                        **named)
        if data is Schemas.OfApply.Data:
            return data(types.get("of"), _READER.arguments(values.get("arguments", [])), parameters=parameters, **named)
        if data is Schemas.OfRelation.Data:
            return data(tuple(values["links"]), _by_name(members.get("properties", [])),
                        tuple(frozenset(unique) for unique in values.get("uniques", [])), parameters=parameters, **named)
        if data is Schemas.OfAdjacency.Data:
            return data(values["name"], types.get("relation"), values["me"], values.get("description"))
        return data(values["name"], types.get("type"), values.get("description"))
    return make


def _assign(make: Callable[[Bindings.State], Any]) -> Callable[[Any, Bindings.State], Any]:
    def assign(instance: Any, state: Bindings.State) -> Any:
        made = make(state)
        instance.__dict__.update(made.__dict__)
        return instance
    return assign


# --- The catalog ---


class Catalog:
    """The schemas a store of schemas holds, in order: its one singleton, from which its data is reached."""

    def __init__(self, schemas: Iterable[Any] = ()):
        self.schemas = list(schemas)

    def identity(self) -> int:
        return id(self)

    def schema_name(self) -> str:
        return CATALOG

    def owner(self) -> None:
        return None

    def accept(self, visitor: Any) -> None:
        Bindings.accept(_CATALOG_BINDING, self, visitor)


def _read_catalog(catalog: Catalog) -> Bindings.State:
    return Bindings.State({}, {"schemas": [Bindings.Entry({"schema": schema}, {"index": index})
                                           for index, schema in enumerate(catalog.schemas)]})


def _listed(state: Bindings.State) -> list[Any]:
    slots = {entry.properties["index"]: entry.links["schema"] for entry in state.entries.get("schemas", [])}
    return [slots[index] for index in sorted(slots)]


def _assign_catalog(catalog: Catalog, state: Bindings.State) -> Catalog:
    catalog.schemas = _listed(state)
    return catalog


_CatalogSchema = Schemas.OfObject.Builder().name(CATALOG).ref().singleton(CATALOG).relations(
    lambda r: r.name("schemas").of(Listed).me("catalog")).create()
_CATALOG_BINDING = Bindings.Binding(_CatalogSchema, _read_catalog, lambda state: Catalog(_listed(state)), _assign_catalog)
Catalog.Schema = _CatalogSchema  # type: ignore[attr-defined]

BINDINGS: dict[type, Bindings.Binding] = {
    data: Bindings.Binding(meta, _read, _make(data), _assign(_make(data)), implied=["owners", "users", "listed"])
    for data, meta in META.items()}


def _accept(schema: Any, visitor: Any) -> None:
    Bindings.accept(BINDINGS[type(schema)], schema, visitor)


Schemas._REFLECTION.update(accept=_accept, names={data: meta.name for data, meta in META.items()})


def store(schemas: Iterable[Any] = ()) -> Bindings.OfStore:
    """A store whose objects are `schemas` and the schemas and elements they hold, listed in order by its catalog,
    `store.singleton("Schemas.Catalog")`."""
    built = Bindings.OfStore(
        [(_CatalogSchema, lambda instance=None: Bindings.Builder(_CATALOG_BINDING, instance)),
         *((meta, lambda instance=None, b=BINDINGS[data]: Bindings.Builder(b, instance)) for data, meta in META.items())],
        [Members, Types, Listed])
    built.singleton(CATALOG).schemas = list(schemas)
    return built
