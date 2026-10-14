"""Modules: schemas as data.

A module is a set of named schemas, held by an object of the meta-schema `Schemas.Module.Schema`, which every proxy
store registers as 'Schemas.Module'. `module(store, schemas)` returns such an object, built in `store`, and
`schemas(store, module)` the schemas a module holds, by name, so that schemas are written, read, validated and compared
like any other objects:

    text = JSON.ToJSON(store)(Schemas.Module.Schema, Modules.module(store, [Contact, Phone]))
    schemas = Modules.schemas(store, JSON.FromJSON(store)(Schemas.Module.Schema, text))

Within a module, each schema is an element by its name, its definition inline, as a value object of its kind. A schema
refers to a named schema by its name, so shared and recursive schemas are written once, and writes an unnamed one
inline. A name resolves within the module, then in the store. A schema that refers to itself must be named.

`reference(schema)` and `resolve(store, definition)` translate one type the same way, for data that refers to schemas
as a module's members do. A predicate's symbols are written as its members are, and its `requires` as a term.

A term (where a width or an argument stands) is written as its neutral form, `Schemas.Form`, and
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
"""A schema's plain form: a mapping from its kind to its contents, e.g. `{"scalar": {"format": "basic", ...}}`."""


def module(store: Stores.Store, schemas: Iterable[Any]) -> Any:
    """A module holding `schemas`, each under its name, built in `store`."""
    schemas = list(schemas)
    unnamed = [schema for schema in schemas if getattr(schema, "name", None) is None]
    if unnamed:
        raise ValueError("a module holds named schemas; name each with its builder's .name()")
    writer = _Writer()
    names = [schema.name for schema in schemas]
    twice = next((name for name in names if names.count(name) > 1), None)
    if twice is not None:
        raise ValueError(f"the module defines {twice!r} twice")
    definitions = {schema.name: writer.definition(schema) for schema in schemas}
    key = f"{MODULE}/{store.builder(MODULE).create().as_identity()}"  # a new identity
    return Plain.FromPlain(store)(Schemas.Module.Schema, {"root": key, "objects": {key: {"schemas": definitions}}})


Make = Callable[[Any], Any]
"""Makes a term of a `Schemas.Form` read from a module, e.g. a dialect's."""


def schemas(store: Stores.Store, module: Any, make: Make | None = None) -> dict[str, Any]:
    """The schemas `module` holds, by name. Names resolve within the module, then in `store`. Terms are read as forms,
    or made by `make`."""
    plain = Plain.ToPlain(store)(Schemas.Module.Schema, module)
    definitions = plain["objects"][plain["root"]].get("schemas", {})  # type: ignore[index, union-attr]
    return _Reader(store, definitions, make).read()


def reference(schema: Any) -> Definition:
    """The plain form of a type (`Schemas.OfAny.Schema`'s): `{"named": {"name": ...}}` for a named schema, else the
    schema inline."""
    return _Writer().reference(schema)


def resolve(store: Stores.Store, definition: Definition, make: Make | None = None) -> Any:
    """The type a plain form describes: a name resolves in `store`, and an inline schema is read."""
    return _Reader(store, {}, make).type(definition)


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
        if isinstance(schema, Schemas.OfScalar.Data):
            if not isinstance(schema.token, Schemas.OfScalar.Token):
                raise TypeError(f"unsupported scalar type {schema.token!r}")
            return _kind_of("scalar", parameters=parameters, format=schema.token.format, token=schema.token.name,
                            bits=_literal(schema.bits), bytes=_literal(schema.bytes),
                            terms=_terms(bits=schema.bits, bytes=schema.bytes), description=schema.description)
        if isinstance(schema, Schemas.OfObject.Data):
            adjacencies = [_present(name=name, relation=self.reference(adjacency.relation), me=adjacency.me,
                                    description=adjacency.description)
                           for name, adjacency in schema.adjacencies.items()]
            return _kind_of("object", parameters=parameters, properties=self._members(schema.properties.values()),
                            adjacencies=adjacencies,
                            singleton=schema.singleton, ref=schema.ref, pattern=schema.pattern,
                            description=schema.description)
        if isinstance(schema, Schemas.OfRelation.Data):
            return _kind_of("relation", parameters=parameters, links=self._members(schema.entry.links.values()),
                            properties=self._members(schema.entry.properties.values()),
                            uniques=[{"clause": _present(names=[{"name": name} for name in sorted(unique)])}
                                     for unique in schema.uniques], description=schema.description)
        if isinstance(schema, Schemas.OfUnion.Data):
            return _kind_of("union", parameters=parameters, branches=self._members(schema.branches),
                            flat=schema.flat or None, description=schema.description)
        if isinstance(schema, Schemas.OfIntersection.Data):
            return _kind_of("intersection", parameters=parameters, parts=self._members(schema.parts),
                            flat=schema.flat or None, description=schema.description)
        if isinstance(schema, Schemas.OfContainer.Data):
            return _kind_of("container", parameters=parameters, index=self.reference(schema.index),
                            element=self.reference(schema.element), layout=schema.layout, description=schema.description)
        if isinstance(schema, Schemas.OfAny.Value):
            return _kind_of("any", parameters=parameters, types=[self.reference(t) for t in schema.types],
                            description=schema.description)
        if isinstance(schema, Schemas.OfApply.Data):
            return _kind_of("apply", parameters=parameters, of=self.reference(schema.of),
                            arguments=_arguments(schema.arguments), description=schema.description)
        if isinstance(schema, Schemas.OfPredicate.Data):
            return _kind_of("predicate", parameters=parameters, symbols=self._members(schema.symbols.values()),
                            requires=None if schema.requires is None else _form(schema.requires),
                            description=schema.description)
        raise TypeError(f"not a schema: {schema!r}")


def _arguments(arguments: Mapping[str, Any]) -> list[dict[str, Any]]:
    """An application's arguments' plain form, in order."""
    return [_argument(name, value) for name, value in arguments.items()]


def _literal(value: Any) -> Any:
    """A width, where it is not a term."""
    return None if Schemas.Form.is_term(value) else value


def _terms(**slots: Any) -> dict[str, Any] | None:
    """The forms of the slots that hold terms, by slot; None if none does."""
    return {slot: _form(value) for slot, value in slots.items() if Schemas.Form.is_term(value)} or None


def _form(term: Any) -> dict[str, Any]:
    """A term's plain form: its neutral form, `Schemas.Form.Schema`'s."""
    form = Schemas.Form.of(term)
    return _present(dialect=form.dialect, kind=form.kind,
                    attributes=[{"name": name, "value": _scalar(value, f"attribute {name!r} of a term")}
                                for name, value in form.attributes.items()],
                    arguments=[{"term": _form(argument)} for argument in form.arguments])


def _scalar(value: Any, what: str) -> dict[str, Any]:
    """A scalar value's plain form, as a `Schemas.Form.Value`: its basic type's branch, e.g. `{"int": 3}`."""
    if type(value) not in Schemas.SCALAR_TYPES:
        raise TypeError(f"{what} is not a scalar value: {value!r}")
    scalar = Schemas.OfScalar.Data(type(value))
    return {scalar.token.name: scalar.to_plain(value)}


def _argument(name: str, value: Any) -> dict[str, Any]:
    """An argument's plain form: its parameter's name, and its scalar `value` or its `term`."""
    if Schemas.Form.is_term(value):
        return {"name": name, "term": _form(value)}
    return {"name": name, "value": _scalar(value, f"argument {name!r}")}


def _kind_of(kind: str, **contents: Any) -> Definition:
    """A schema's plain form, leaving out what is absent, false or empty, as a reader assumes."""
    return {kind: _present(**contents)}


def _present(**contents: Any) -> dict[str, Any]:
    """`contents` without what is absent, false or empty."""
    return {key: value for key, value in contents.items() if value is not None and value is not False and value != []}


# --- Plain data to schemas ---


_BLANK = {"scalar": Schemas.OfScalar.Data, "object": Schemas.OfObject.Data, "relation": Schemas.OfRelation.Data,
          "union": Schemas.OfUnion.Data, "intersection": Schemas.OfIntersection.Data,
          "container": Schemas.OfContainer.Data, "apply": Schemas.OfApply.Data, "any": Schemas.OfAny.Value,
          "predicate": Schemas.OfPredicate.Data}


def _contents_of(definition: Definition) -> tuple[str, dict[str, Any]]:
    """A schema's kind and contents; a module's union values hold exactly one branch."""
    ((kind, body),) = definition.items()
    return kind, body


class _Reader:
    """Reads the schemas of a module's plain definitions, by name. Each named schema is created first, so that
    references to it, recursive ones included, resolve to it."""

    def __init__(self, store: Stores.Store, definitions: dict[str, Definition], make: Make | None = None):
        self._store, self._definitions, self._make = store, definitions, make
        self._defined: dict[str, Any] = {}

    def read(self) -> dict[str, Any]:
        for name, definition in self._definitions.items():
            self._defined[name] = _BLANK[_contents_of(definition)[0]]()
            self._defined[name].name = name
        for name, definition in self._definitions.items():
            self._fill(self._defined[name], definition)
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
        if isinstance(schema, (Schemas.OfRelation.Data, Schemas.OfPredicate.Data)):
            kind = "relation" if isinstance(schema, Schemas.OfRelation.Data) else "predicate"
            raise TypeError(f"{body['name']!r} is a {kind}, not a type")
        return schema

    def _relation(self, definition: Definition) -> Any:
        kind, body = _contents_of(definition)
        if kind != "named":
            return self._fill(Schemas.OfRelation.Data(), definition)
        schema = self._named(body["name"])
        if not isinstance(schema, Schemas.OfRelation.Data):
            raise TypeError(f"{body['name']!r} is not a relation")
        return schema

    def _members(self, members: list[dict[str, Any]], data: type, what: str) -> list[Any]:
        """Properties, branches, parts or parameters (`what`), as elements of `data`'s kind."""
        _once(members, what)
        return [data(member["name"], self.type(member["type"]) if "type" in member else None, member.get("description"))
                for member in members]

    def _term(self, plain: dict[str, Any]) -> Any:
        """The term a plain form describes: a form, or what `make` makes of it."""
        form = self._form(plain)
        return form if self._make is None else self._make(form)

    def _form(self, plain: dict[str, Any]) -> Any:
        _once(plain.get("attributes", []), "attribute")
        return Schemas.Form.Data(plain["kind"], {a["name"]: _scalar_of(a["value"]) for a in plain.get("attributes", [])},
                                 tuple(self._form(argument["term"]) for argument in plain.get("arguments", [])),
                                 plain.get("dialect"))

    def _slot(self, body: dict[str, Any], slot: str) -> Any:
        """A width: its int, or the term `terms` holds for it."""
        terms = body.get("terms", {})
        return self._term(terms[slot]) if slot in terms else body.get(slot)

    def _fill(self, schema: Any, definition: Definition) -> Any:
        """Writes the contents of `definition` into `schema`, a blank schema of its kind, and returns it."""
        kind, body = _contents_of(definition)
        schema.description = body.get("description")
        schema.parameters = {p.name: p for p in self._members(body.get("parameters", []), Schemas.OfParameter.Data, "parameter")}
        properties = self._members(body.get("properties", []), Schemas.OfProperty.Data, "property")
        if kind == "scalar":
            schema.token = Schemas.OfScalar.Token(body["format"], body["token"])
            schema.bits, schema.bytes = self._slot(body, "bits"), self._slot(body, "bytes")
        elif kind == "object":
            schema.properties = {p.name: p for p in properties}
            _once(body.get("adjacencies", []), "adjacency")
            schema.adjacencies = {a["name"]: Schemas.OfAdjacency.Data(a["name"], self._relation(a["relation"]), a["me"],
                                                                      a.get("description"))
                                  for a in body.get("adjacencies", [])}
            schema.singleton, schema.ref, schema.pattern = body.get("singleton"), body.get("ref", False), body.get("pattern")
        elif kind == "relation":
            links = self._members(body.get("links", []), Schemas.OfSymbol.Data, "link")
            schema.entry = Schemas.OfEntry.Data({link.name: link for link in links}, {p.name: p for p in properties})
            schema.uniques = tuple(frozenset(name["name"] for name in unique["clause"].get("names", []))
                                   for unique in body.get("uniques", []))
        elif kind == "union":
            schema.branches = tuple(self._members(body.get("branches", []), Schemas.OfUnion.Branch, "branch"))
            schema.flat = body.get("flat", False)
        elif kind == "intersection":
            schema.parts = tuple(self._members(body.get("parts", []), Schemas.OfIntersection.Part, "part"))
            schema.flat = body.get("flat", False)
        elif kind == "container":
            schema.index, schema.element = self.type(body["index"]), self.type(body["element"])
            schema.layout = body.get("layout")
        elif kind == "any":
            schema.types = tuple(self.type(t) for t in body.get("types", []))
        elif kind == "apply":
            schema.of = self.type(body["of"])
            schema.arguments = self.arguments(body.get("arguments", []))
        else:
            schema.symbols = {s.name: s for s in self._members(body.get("symbols", []), Schemas.OfSymbol.Data, "symbol")}
            schema.requires = self._term(body["requires"]) if "requires" in body else None
        return schema

    def arguments(self, plain: list[dict[str, Any]]) -> dict[str, Any]:
        """The arguments a plain form describes, by name: scalar values, or terms."""
        _once(plain, "argument")
        return {a["name"]: self._term(a["term"]) if "term" in a else _scalar_of(a["value"]) for a in plain}


def _once(members: list[dict[str, Any]], what: str) -> None:
    """Refuses a list of a schema's members that names one twice: a schema's lists are in declaration order, so
    nothing but this keeps their names distinct."""
    names = [member["name"] for member in members]
    for name in names:
        if names.count(name) > 1:
            raise ValueError(f"{what} {name!r} is listed twice")


def _scalar_of(plain: dict[str, Any]) -> Any:
    """The scalar value of a `Schemas.Form.Value`'s plain form, e.g. `{"int": 3}`."""
    ((name, value),) = plain.items()
    return Schemas.OfScalar.Data(Schemas.OfScalar.Token(Schemas.BASIC, name)).from_plain(value)
