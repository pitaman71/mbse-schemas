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

A term (where a width, an extent's bound or an argument stands) is written as its neutral form, `Schemas.Form`, and
read back as one; `make`, given to `schemas` or `resolve`, makes a dialect's term of each form instead.

The translation goes through plain data, the form `Plain`, `JSON` and `YAML` share: `module` decodes the plain form of
the schemas in the store, and `schemas` reads the plain form of the module.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
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


Make = Callable[[Any], Any]
"""Makes a term of a `Schemas.Form` read from a module, e.g. a dialect's."""


def schemas(store: Stores.Store, module: Any, make: Make | None = None) -> dict[str, Any]:
    """The schemas `module` holds, by name. Names resolve within the module, then in `store`. Terms are read as forms,
    or made by `make`."""
    plain = Plain.ToPlain(store)(Schemas.Module.Schema, module)
    entries = plain["objects"][plain["root"]].get("schemas", [])  # type: ignore[index, union-attr]
    return _Reader(store, entries, make).read()


def reference(schema: Any) -> Definition:
    """The plain form of a type (`Schemas.OfAny.Schema`'s): `{"named": {"name": ...}}` for a named schema, else the
    schema inline."""
    return _Writer().reference(schema)


def resolve(store: Stores.Store, definition: Definition, make: Make | None = None) -> Any:
    """The type a plain form describes: a name resolves in `store`, and an inline schema is read."""
    return _Reader(store, [], make).type(definition)


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
        """Properties, branches, parts or parameters: each its name, its type (a parameter may have none) and its
        description, if any."""
        return [_present(name=member.name, type=None if member.type is None else self.reference(member.type),
                         description=member.description)
                for member in members]

    def _contents(self, schema: Any) -> Definition:
        parameters = self._members(schema.parameters.values()) if hasattr(schema, "parameters") else []
        if isinstance(schema, Schemas.OfNative.Data):
            if not isinstance(schema.token, Schemas.OfNative.Token):
                raise TypeError(f"unsupported native type {schema.token!r}")
            return _kind_of("native", parameters=parameters, format=schema.token.format, token=schema.token.name,
                            bits=_literal(schema.bits), bytes=_literal(schema.bytes),
                            terms=_terms(bits=schema.bits, bytes=schema.bytes), description=schema.description)
        if isinstance(schema, Schemas.OfObject.Data):
            adjacencies = [_present(name=name, relation=self.reference(adjacency.relation), me=adjacency.me,
                                    description=adjacency.description)
                           for name, adjacency in schema.adjacencies.items()]
            return _kind_of("object", parameters=parameters, properties=self._members(schema.properties.values()),
                            adjacencies=adjacencies,
                            singleton=schema.singleton, ref=schema.ref, description=schema.description)
        if isinstance(schema, Schemas.OfRelation.Data):
            return _kind_of("relation", parameters=parameters, links=list(schema.links),
                            properties=self._members(schema.properties.values()),
                            uniques=[sorted(unique) for unique in schema.uniques], description=schema.description)
        if isinstance(schema, Schemas.OfUnion.Data):
            return _kind_of("union", parameters=parameters, branches=self._members(schema.branches),
                            flat=schema.flat or None, description=schema.description)
        if isinstance(schema, Schemas.OfIntersection.Data):
            return _kind_of("intersection", parameters=parameters, parts=self._members(schema.parts),
                            flat=schema.flat or None, description=schema.description)
        if isinstance(schema, Schemas.OfIndexed.Data):
            return _kind_of("indexed", parameters=parameters, item=self.reference(schema.item),
                            key=None if schema.key is None else self.reference(schema.key), extent=_extent(schema.extent),
                            description=schema.description)
        if isinstance(schema, Schemas.OfApply.Data):
            return _kind_of("apply", parameters=parameters, of=self.reference(schema.of),
                            arguments=_arguments(schema.arguments), description=schema.description)
        raise TypeError(f"not a schema: {schema!r}")


def _extent(extent: Any) -> dict[str, Any] | None:
    """An extent's plain form: its int bounds, and the terms that stand for the others; None for none."""
    if extent is None:
        return None
    return _present(minimum=_literal(extent.minimum), maximum=_literal(extent.maximum),
                    terms=_terms(minimum=extent.minimum, maximum=extent.maximum))


def _arguments(arguments: Mapping[str, Any]) -> list[dict[str, Any]]:
    """An application's arguments' plain form, in order."""
    return [_argument(name, value) for name, value in arguments.items()]


def _literal(value: Any) -> Any:
    """A width or a bound, where it is not a term."""
    return None if Schemas.Form.is_term(value) else value


def _terms(**slots: Any) -> dict[str, Any] | None:
    """The forms of the slots that hold terms, by slot; None if none does."""
    return {slot: _form(value) for slot, value in slots.items() if Schemas.Form.is_term(value)} or None


def _form(term: Any) -> dict[str, Any]:
    """A term's plain form: its neutral form, `Schemas.Form.Schema`'s."""
    form = Schemas.Form.of(term)
    return _present(dialect=form.dialect, kind=form.kind,
                    attributes=[{"name": name, "value": _native(value, f"attribute {name!r} of a term")}
                                for name, value in form.attributes.items()],
                    arguments=[_form(argument) for argument in form.arguments])


def _native(value: Any, what: str) -> dict[str, Any]:
    """A native value's plain form, as a `Schemas.Form.Value`: its basic type's branch, e.g. `{"int": 3}`."""
    if type(value) not in Schemas.NATIVE_TYPES:
        raise TypeError(f"{what} is not a native value: {value!r}")
    native = Schemas.OfNative.Data(type(value))
    return {native.token.name: native.to_plain(value)}


def _argument(name: str, value: Any) -> dict[str, Any]:
    """An argument's plain form: its parameter's name, and its native `value` or its `term`."""
    if Schemas.Form.is_term(value):
        return {"name": name, "term": _form(value)}
    return {"name": name, "value": _native(value, f"argument {name!r}")}


def _kind_of(kind: str, **contents: Any) -> Definition:
    """A schema's plain form, leaving out what is absent, false or empty, as a reader assumes."""
    return {kind: _present(**contents)}


def _present(**contents: Any) -> dict[str, Any]:
    """`contents` without what is absent, false or empty."""
    return {key: value for key, value in contents.items() if value is not None and value is not False and value != []}


# --- Plain data to schemas ---


_BLANK = {"native": Schemas.OfNative.Data, "object": Schemas.OfObject.Data, "relation": Schemas.OfRelation.Data,
          "union": Schemas.OfUnion.Data, "intersection": Schemas.OfIntersection.Data, "indexed": Schemas.OfIndexed.Data,
          "apply": Schemas.OfApply.Data}


def _contents_of(definition: Definition) -> tuple[str, dict[str, Any]]:
    """A schema's kind and contents; a module's union values hold exactly one branch."""
    ((kind, body),) = definition.items()
    return kind, body


class _Reader:
    """Reads the schemas of a module's plain entries. Each named schema is created first, so that references to it,
    recursive ones included, resolve to it."""

    def __init__(self, store: Stores.Store, entries: list[dict[str, Any]], make: Make | None = None):
        self._store, self._entries, self._make = store, entries, make
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

    def _members(self, members: list[dict[str, Any]], data: type) -> list[Any]:
        """Properties, branches, parts or parameters, as elements of `data`'s kind."""
        return [data(member["name"], self.type(member["type"]) if "type" in member else None, member.get("description"))
                for member in members]

    def _term(self, plain: dict[str, Any]) -> Any:
        """The term a plain form describes: a form, or what `make` makes of it."""
        form = self._form(plain)
        return form if self._make is None else self._make(form)

    def _form(self, plain: dict[str, Any]) -> Any:
        return Schemas.Form.Data(plain["kind"], {a["name"]: _native_of(a["value"]) for a in plain.get("attributes", [])},
                                 tuple(self._form(argument) for argument in plain.get("arguments", [])),
                                 plain.get("dialect"))

    def _slot(self, body: dict[str, Any], slot: str, absent: Any = None) -> Any:
        """A width or a bound: its int, or the term `terms` holds for it."""
        terms = body.get("terms", {})
        return self._term(terms[slot]) if slot in terms else body.get(slot, absent)

    def _fill(self, schema: Any, definition: Definition) -> Any:
        """Writes the contents of `definition` into `schema`, a blank schema of its kind, and returns it."""
        kind, body = _contents_of(definition)
        schema.description = body.get("description")
        schema.parameters = {p.name: p for p in self._members(body.get("parameters", []), Schemas.OfParameter.Data)}
        properties = self._members(body.get("properties", []), Schemas.OfProperty.Data)
        if kind == "native":
            schema.token = Schemas.OfNative.Token(body["format"], body["token"])
            schema.bits, schema.bytes = self._slot(body, "bits"), self._slot(body, "bytes")
        elif kind == "object":
            schema.properties = {p.name: p for p in properties}
            schema.adjacencies = {a["name"]: Schemas.OfAdjacency.Data(a["name"], self._relation(a["relation"]), a["me"],
                                                                      a.get("description"))
                                  for a in body.get("adjacencies", [])}
            schema.singleton, schema.ref = body.get("singleton"), body.get("ref", False)
        elif kind == "relation":
            schema.links = tuple(body.get("links", []))
            schema.properties = {p.name: p for p in properties}
            schema.uniques = tuple(frozenset(unique) for unique in body.get("uniques", []))
        elif kind == "union":
            schema.branches = tuple(self._members(body.get("branches", []), Schemas.OfUnion.Branch))
            schema.flat = body.get("flat", False)
        elif kind == "intersection":
            schema.parts = tuple(self._members(body.get("parts", []), Schemas.OfIntersection.Part))
            schema.flat = body.get("flat", False)
        elif kind == "indexed":
            schema.item = self.type(body["item"])
            schema.key = self.type(body["key"]) if "key" in body else None
            schema.extent = self.extent(body.get("extent"))
        else:
            schema.of = self.type(body["of"])
            schema.arguments = self.arguments(body.get("arguments", []))
        return schema

    def extent(self, plain: dict[str, Any] | None) -> Any:
        """The extent a plain form describes, or None."""
        return None if plain is None else Schemas.OfIndexed.Extent(self._slot(plain, "minimum", 0), self._slot(plain, "maximum"))

    def arguments(self, plain: list[dict[str, Any]]) -> dict[str, Any]:
        """The arguments a plain form describes, by name: native values, or terms."""
        return {a["name"]: self._term(a["term"]) if "term" in a else _native_of(a["value"]) for a in plain}


def _native_of(plain: dict[str, Any]) -> Any:
    """The native value of a `Schemas.Form.Value`'s plain form, e.g. `{"int": 3}`."""
    ((name, value),) = plain.items()
    return Schemas.OfNative.Data(Schemas.OfNative.Token(Schemas.BASIC, name)).from_plain(value)
