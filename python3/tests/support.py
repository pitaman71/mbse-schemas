"""Shared helpers for the test notebooks. Each notebook runs in its own kernel and makes its own stores."""

from __future__ import annotations

import inspect
import json
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from mbse.Schemas.Framework import Builders


@contextmanager
def raises(*errors: type[BaseException], match: str | None = None) -> Iterator[None]:
    """Asserts that the block raises one of `errors`, optionally with `match` in the message."""
    try:
        yield
    except errors as error:
        if match is not None and match not in str(error):
            raise AssertionError(f"expected {match!r} in {str(error)!r}") from error
        return
    raise AssertionError(f"expected one of {[e.__name__ for e in errors]}")


BASIC = {str: "OfStr", int: "OfInt", float: "OfFloat", bool: "OfBool", bytes: "OfBytes"}


def basic(store: Any, scalar: type) -> Any:
    """The basic scalar schema of a host type in `store`, which holds its own."""
    return getattr(store.Schemas, BASIC[scalar]).as_schema()


def entries(schema: Any, obj: Any, adjacency: str) -> list[dict[str, Any]]:
    """An object's entries, read through the visitor protocol: each a dict of the other links' objects and the values
    of the properties that are set (a value object as its visitor)."""
    read = getattr(obj, adjacency)
    me = read.as_schema().me
    rows = []
    for entry in read:
        row = {link: getattr(entry, link) for link in entry.as_schema().links if link != me}
        for name, prop in entry.as_schema().properties.items():
            value = value_of(getattr(entry, name))
            if value is not None:
                row[name] = value
        rows.append(row)
    return rows


def value_of(read: Any) -> Any:
    """A property's value, read through its visitor: its scalar, or the value object, union value or intersection value
    it holds, as that value's visitor; None when absent."""
    if read.get() is not None:
        return read.get()
    found: list[Any] = []
    read.as_value(lambda a: a.as_object(lambda v: found.append(v) or v).as_union(lambda v: found.append(v) or v)
                  .as_intersection(lambda v: found.append(v) or v))
    return next((v for v in found if v.as_schema() is not None), None)  # a visitor of nothing has no schema


def schema_name(path: dict) -> str:
    """The registered name a schema object's path, as plain data, gives: its modules' names and its own, dotted."""
    names, step = [], path["next"]
    while "entry" in step:
        names.append(step["entry"]["properties"]["name"])
        step = step["entry"]["next"]
    return ".".join(names)


def view(document: dict) -> dict:
    """A document (`Plain.ToPlain(store).Reachable`: one transaction, one upsert) as the objects it holds, each listed by
    its number (its symbol), its schema's name and its members: the properties its spec sets, then the entries it
    inserts, each a mapping of its links, `{'$ref': {'n': number}}` or `{'$ref': path}`, and its properties."""
    pattern = document["mutations"][0]["upsert"]["exists"][0]
    specs: dict = {}
    for item in pattern.get("spec", []):
        for symbol, members in item.items():
            specs.setdefault(symbol, []).extend(members)

    def row(entry: dict) -> dict:
        out = {}
        for member in entry["mutations"]:
            (kind, body), = member.items()
            given = body["mutations"][0]["set"]
            if kind == "as_property":
                out[body["name"]] = given["value"]
            else:
                ref = given["ref"]
                out[body["name"]] = {"$ref": {"n": int(ref["symbol"])} if "symbol" in ref else ref["path"]}
        return out

    objects = []
    for symbol, held in pattern["symbols"].items():
        properties: dict = {}
        for member in specs.get(symbol, []):
            (kind, body), = member.items()
            if kind == "as_property":
                properties[body["name"]] = body["mutations"][0]["set"]["value"]
            else:
                properties[body["name"]] = [row(entry) for entry in body["mutations"][0]["insert"]["entries"]]
        objects.append(listed(schema_name(held["schema"][0]["$ref"]), int(symbol), properties))
    return {"root": {"n": 0}, "objects": objects}


def schema_path(name: str) -> dict:
    """A registered schema's path, as plain data: from the root module, through its modules, to it by name."""
    step: dict = {"target": {}}
    for part in reversed(name.split(".")):
        step = {"entry": {"i": "schemas", "o": "", "properties": {"name": part}, "next": step}}
    return {"singleton": ".", "next": step}


def document(listed_objects: dict, uid: str | None = None) -> dict:
    """The document `view` lists: one transaction, each object a symbol, its number, of the schema its name gives, its
    properties set and its entries inserted, a reference by number to the symbol, else by path."""

    def given(name: str, value: Any) -> dict:
        return {"as_property": {"name": name, "mutations": [{"set": {"value": value}}]}}

    def entry(row: dict) -> dict:
        mutations = []
        for name, value in row.items():
            if isinstance(value, dict) and "$ref" in value:
                ref = value["$ref"]
                ref = {"symbol": str(ref["n"])} if "n" in ref else {"path": ref}
                mutations.append({"as_link": {"name": name, "mutations": [{"set": {"ref": ref}}]}})
            else:
                mutations.append(given(name, value))
        return {"mutations": mutations}

    symbols, spec = {}, []
    for listing_ in listed_objects["objects"]:
        symbol = str(listing_["n"])
        symbols[symbol] = {"schema": [{"$ref": schema_path(listing_["schema"])}]}
        members = [{"as_adjacency": {"name": name, "mutations": [{"insert": {"entries": [entry(row) for row in value]}}]}}
                   if is_adjacency(value) else given(name, value) for name, value in listing_["properties"].items()]
        if members:
            spec.append({symbol: members})
    pattern = {"symbols": symbols, **({"spec": spec} if spec else {})}
    upsert = {**({} if uid is None else {"key": uid}), "exists": [pattern]}
    return {**({} if uid is None else {"uid": uid}), "mutations": [{"upsert": upsert}]}


def listing(snapshot: dict) -> dict:
    """A document as `view` gives it; an object listing as it is."""
    return view(snapshot) if "mutations" in snapshot else snapshot


def listed(name: str, number: int, properties: dict | None = None) -> dict:
    """A counted object's entry in an object snapshot's list: its number in the document, its schema's name and its
    members (docs/OBJECT_IDENTITY.md, Decided, 55)."""
    return {"n": number, "schema": name, "properties": properties or {}}


def single(name: str, properties: dict | None = None) -> dict:
    """The object snapshot of one counted object: rooted at it, listing it alone, numbered 0."""
    return {"root": {"n": 0}, "objects": [listed(name, 0, properties)]}


def ref(number: int) -> dict:
    """A reference to the counted object a document numbers `number`."""
    return {"$ref": {"n": number}}


def path_of(obj: Any) -> dict:
    """An owned object's or a singleton's path (`Paths.of`), as plain data."""
    from mbse.Schemas.Framework import Paths, Plain

    identity = Paths.of(obj)
    return Plain.ToPlain(None)(identity.as_schema(), identity)


def key_of(obj: Any) -> Any:
    """An owned object's key: the `name` of its path's last step, or a singleton's global name."""
    return key_in(path_of(obj))


def key_in(path: dict) -> Any:
    """The key a path, as plain data, ends with: the `name` of its last step, or a singleton's global name."""
    key, step = path["singleton"], path["next"]
    while "entry" in step:
        key = step["entry"]["properties"].get("name")
        step = step["entry"]["next"]
    return key


def called(listing: dict) -> dict:
    """What an object snapshot calls one of the objects it lists: its path, or `{'n': number}`."""
    return listing["path"] if "path" in listing else {"n": listing["n"]}


def _symbol(path: Any) -> str:
    return json.dumps(path, sort_keys=True)


def members(snapshot: dict, call: Any) -> dict:
    """The members of the object an object snapshot lists as `call`: a path, or a counted object's number."""
    wanted = _symbol({"n": call} if isinstance(call, int) else call)
    return next(o["properties"] for o in listing(snapshot)["objects"] if _symbol(called(o)) == wanted)


def root_of(snapshot: dict) -> dict:
    """A snapshot's root object's members."""
    return members(snapshot, listing(snapshot)["root"])


def is_adjacency(value: Any) -> bool:
    """Whether a snapshot's list is an adjacency: each of its entries links something, while a list a property holds
    never has a reference at its top level."""
    return isinstance(value, list) and bool(value) and all(
        isinstance(e, dict) and any(isinstance(v, dict) and "$ref" in v for v in e.values()) for e in value)


def same_graph(a: dict, b: dict) -> bool:
    """Snapshot equality up to the keys objects are written under, the order they are written in, and entry order.
    Objects are identified by their own property values, which must be distinct within each graph, and value objects by
    their owner's and the path to them."""

    def content(value: Any) -> Any:
        """A value without the keys and entries in it."""
        if isinstance(value, dict):
            return sorted((k, content(v)) for k, v in value.items() if k != "$id" and not is_adjacency(v))
        if isinstance(value, list):
            return [content(v) for v in value]
        return value

    def canonical(graph: dict) -> tuple:
        objects = {_symbol(called(o)): o["properties"] for o in graph["objects"]}
        labels = {s: repr(content(o)) for s, o in objects.items()}
        assert len(set(labels.values())) == len(labels), "objects must have distinct property values"
        holders: list[tuple[str, dict]] = []  # every object and value object, by label

        def visit(label: str, value: Any) -> None:
            if isinstance(value, list):
                for i, item in enumerate(value):
                    visit(f"{label}[{i}]", item)
            elif isinstance(value, dict):
                holders.append((label, value))
                if "$id" in value:
                    labels[value["$id"]] = label
                for key, item in value.items():
                    if key != "$schema" and not is_adjacency(item):
                        visit(f"{label}.{key}", item)

        for symbol, obj in objects.items():
            visit(labels[symbol], obj)

        def entry(e: dict) -> str:
            return repr(sorted((k, labels[_symbol(v["$ref"])] if isinstance(v, dict) and "$ref" in v else v)
                               for k, v in e.items()))

        return labels[_symbol(graph["root"])], {
            label: {k: sorted(map(entry, v)) for k, v in mapping.items() if is_adjacency(v)} for label, mapping in holders
        }

    return canonical(listing(a)) == canonical(listing(b))


def protocol_methods(protocol: type) -> dict[str, inspect.Signature]:
    """Public methods declared by a `typing.Protocol`, with their signatures."""
    return {
        name: inspect.signature(member)
        for name, member in vars(protocol).items()
        if callable(member) and not name.startswith("_")
    }


def conformance_problems(implementation: type, protocol: type) -> list[str]:
    """Methods of `protocol` that `implementation` lacks, or declares with a different number of parameters."""
    problems = []
    for name, expected in protocol_methods(protocol).items():
        member = getattr(implementation, name, None)
        if not callable(member):
            problems.append(f"{implementation.__name__} lacks {protocol.__name__}.{name}")
            continue
        actual = inspect.signature(member)
        if len(actual.parameters) != len(expected.parameters):
            problems.append(
                f"{implementation.__name__}.{name}{actual} does not match {protocol.__name__}.{name}{expected}"
            )
    return problems


def instance_problems(instance: Any, protocol: type) -> list[str]:
    """The conformance check on a live instance: catches instance attributes that shadow protocol methods."""
    return [
        f"{type(instance).__name__} instance: {protocol.__name__}.{name} is not callable"
        for name in protocol_methods(protocol)
        if not callable(getattr(instance, name, None))
    ]
