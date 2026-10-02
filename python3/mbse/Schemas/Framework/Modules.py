"""Modules: schemas as data.

A module is a set of named schemas, held by an object of the meta-schema `Schemas.Module.Schema`, which every proxy
store registers as 'Schemas.Module'. `module(store, schemas)` returns such an object, built in `store`, and
`schemas(store, module)` the schemas a module holds, by name, so that schemas are written, read, validated and compared
like any other objects:

    text = JSON.ToJSON(store)(Schemas.Module.Schema, Modules.module(store, [Contact, Phone]))
    schemas = Modules.schemas(store, JSON.FromJSON(store)(Schemas.Module.Schema, text))

Within a module, each schema is an entry, its name and its definition, inline, as a value object of its kind. A schema
refers to a named schema by its name, so shared and recursive schemas are written once, and writes an unnamed one
inline. A name resolves within the module, then in the store. A schema that refers to itself must be named.

`reference(schema)` and `resolve(store, definition)` translate one type the same way, for data that refers to schemas
as a module's members do, e.g. the symbols of a predicate.

The translation goes through plain data, the form `Plain`, `JSON` and `YAML` share: `module` decodes the plain form of
the schemas in the store, and `schemas` reads the plain form of the module.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from . import Plain, Schemas, Stores

__all__ = ["MODULE", "module", "schemas", "reference", "resolve"]

MODULE = "Schemas.Module"

Definition = dict[str, Any]
"""A schema's plain form: a mapping from its kind to its contents, e.g. `{"native": {"format": "basic", ...}}`."""


def module(store: Stores.Store, schemas: Iterable[Any]) -> Any:
    """A module holding `schemas`, each under its name, built in `store`."""
    schemas = list(schemas)
    unnamed = [schema for schema in schemas if getattr(schema, "name", None) is None]
    if unnamed:
        raise ValueError("a module holds named schemas; name each with its builder's .name()")
    writer = _Writer()
    entries = [{"name": schema.name, "schema": writer.definition(schema)} for schema in schemas]
    return Plain.FromPlain(store)(Schemas.Module.Schema, {"root": "s0", "objects": {"s0": {"schemas": entries}}})


def schemas(store: Stores.Store, module: Any) -> dict[str, Any]:
    """The schemas `module` holds, by name. Names resolve within the module, then in `store`."""
    plain = Plain.ToPlain(store)(Schemas.Module.Schema, module)
    entries = plain["objects"][plain["root"]].get("schemas", [])  # type: ignore[index, union-attr]
    return _Reader(store, entries).read()


def reference(schema: Any) -> Definition:
    """The plain form of a type (`Schemas.OfAny.Schema`'s): `{"named": {"name": ...}}` for a named schema, else the
    schema inline."""
    return _Writer().reference(schema)


def resolve(store: Stores.Store, definition: Definition) -> Any:
    """The type a plain form describes: a name resolves in `store`, and an inline schema is read."""
    return _Reader(store, []).type(definition)


# --- Schemas to plain data ---


class _Writer:
    """Writes schemas as plain data, referring to named schemas by name."""

    def __init__(self) -> None:
        self._inline: set[int] = set()  # the schemas being written inline, to refuse one that refers to itself

    def reference(self, schema: Any) -> Definition:
        """A type or a relation, by name if it has one, else inline."""
        name = getattr(schema, "name", None)
        return {"named": {"name": name}} if name is not None else self.definition(schema)

    def definition(self, schema: Any) -> Definition:
        """A schema written inline."""
        if id(schema) in self._inline:
            raise ValueError("a schema that refers to itself must be named")
        self._inline.add(id(schema))
        try:
            return self._contents(schema)
        finally:
            self._inline.discard(id(schema))

    def _members(self, members: Any) -> list[Definition]:
        return [{"name": name, "type": self.reference(schema)} for name, schema in members]

    def _contents(self, schema: Any) -> Definition:
        if isinstance(schema, Schemas.OfNative.Data):
            if not isinstance(schema.token, Schemas.OfNative.Token):
                raise TypeError(f"unsupported native type {schema.token!r}")
            return _kind_of("native", format=schema.token.format, name=schema.token.name, bits=schema.bits,
                            bytes=schema.bytes)
        if isinstance(schema, Schemas.OfObject.Data):
            adjacencies = [{"name": name, "relation": self.reference(adjacency.relation), "me": adjacency.me}
                           for name, adjacency in schema.adjacencies.items()]
            return _kind_of("object", properties=self._members(schema.properties.items()), adjacencies=adjacencies,
                            singleton=schema.singleton, ref=schema.ref)
        if isinstance(schema, Schemas.OfRelation.Data):
            return _kind_of("relation", links=list(schema.links), properties=self._members(schema.properties.items()),
                            uniques=[sorted(unique) for unique in schema.uniques])
        if isinstance(schema, Schemas.OfUnion.Data):
            return _kind_of("union", branches=self._members((b.name, b.type) for b in schema.branches))
        if isinstance(schema, Schemas.OfIntersection.Data):
            return _kind_of("intersection", parts=self._members((p.name, p.type) for p in schema.parts))
        if isinstance(schema, Schemas.OfIndexed.Data):
            extent = None if schema.extent is None else {
                key: value for key, value in (("minimum", schema.extent.minimum), ("maximum", schema.extent.maximum))
                if value is not None}
            return _kind_of("indexed", item=self.reference(schema.item),
                            key=None if schema.key is None else self.reference(schema.key), extent=extent)
        raise TypeError(f"not a schema: {schema!r}")


def _kind_of(kind: str, **contents: Any) -> Definition:
    """A schema's plain form, leaving out what is absent, false or empty, as a reader assumes."""
    return {kind: {key: value for key, value in contents.items() if value is not None and value is not False and value != []}}


# --- Plain data to schemas ---


_BLANK = {"native": Schemas.OfNative.Data, "object": Schemas.OfObject.Data, "relation": Schemas.OfRelation.Data,
          "union": Schemas.OfUnion.Data, "intersection": Schemas.OfIntersection.Data, "indexed": Schemas.OfIndexed.Data}


def _contents_of(definition: Definition) -> tuple[str, dict[str, Any]]:
    """A schema's kind and contents; a module's union values hold exactly one branch."""
    ((kind, body),) = definition.items()
    return kind, body


class _Reader:
    """Reads the schemas of a module's plain entries. Each named schema is created first, so that references to it,
    recursive ones included, resolve to it."""

    def __init__(self, store: Stores.Store, entries: list[dict[str, Any]]):
        self._store, self._entries = store, entries
        self._defined: dict[str, Any] = {}

    def read(self) -> dict[str, Any]:
        for entry in self._entries:
            if entry["name"] in self._defined:
                raise ValueError(f"the module defines {entry['name']!r} twice")
            self._defined[entry["name"]] = _BLANK[_contents_of(entry["schema"])[0]]()
            self._defined[entry["name"]].name = entry["name"]
        for entry in self._entries:
            self._fill(self._defined[entry["name"]], entry["schema"])
        return dict(self._defined)

    def _named(self, name: str) -> Any:
        if name in self._defined:
            return self._defined[name]
        try:
            return self._store.registered(name)
        except LookupError:
            raise LookupError(f"no schema named {name!r} in the module or the store") from None

    def type(self, definition: Definition) -> Any:
        kind, body = _contents_of(definition)
        if kind != "named":
            return self._fill(_BLANK[kind](), definition)
        schema = self._named(body["name"])
        if isinstance(schema, Schemas.OfRelation.Data):
            raise TypeError(f"{body['name']!r} is a relation, not a type")
        return schema

    def _relation(self, definition: Definition) -> Any:
        kind, body = _contents_of(definition)
        if kind != "named":
            return self._fill(Schemas.OfRelation.Data(), definition)
        schema = self._named(body["name"])
        if not isinstance(schema, Schemas.OfRelation.Data):
            raise TypeError(f"{body['name']!r} is not a relation")
        return schema

    def _members(self, members: list[dict[str, Any]]) -> list[tuple[str, Any]]:
        return [(member["name"], self.type(member["type"])) for member in members]

    def _fill(self, schema: Any, definition: Definition) -> Any:
        """Writes the contents of `definition` into `schema`, a blank schema of its kind, and returns it."""
        kind, body = _contents_of(definition)
        if kind == "native":
            schema.token = Schemas.OfNative.Token(body["format"], body["name"])
            schema.bits, schema.bytes = body.get("bits"), body.get("bytes")
        elif kind == "object":
            schema.properties = dict(self._members(body.get("properties", [])))
            schema.adjacencies = {a["name"]: Schemas.OfAdjacency.Data(a["name"], self._relation(a["relation"]), a["me"])
                                  for a in body.get("adjacencies", [])}
            schema.singleton, schema.ref = body.get("singleton"), body.get("ref", False)
        elif kind == "relation":
            schema.links = tuple(body.get("links", []))
            schema.properties = dict(self._members(body.get("properties", [])))
            schema.uniques = tuple(frozenset(unique) for unique in body.get("uniques", []))
        elif kind == "union":
            schema.branches = tuple(Schemas.OfUnion.Branch(n, t) for n, t in self._members(body.get("branches", [])))
        elif kind == "intersection":
            schema.parts = tuple(Schemas.OfIntersection.Part(n, t) for n, t in self._members(body.get("parts", [])))
        else:
            schema.item = self.type(body["item"])
            schema.key = self.type(body["key"]) if "key" in body else None
            extent = body.get("extent")
            schema.extent = None if extent is None else Schemas.OfIndexed.Extent(extent.get("minimum", 0), extent.get("maximum"))
        return schema
