"""Helpers built in the tutorials, collected so later case studies can import them.

Each function is developed and explained in the case study named in its docstring.
"""

from mbse.Schemas.Framework import Proxies


def entries(obj, adjacency):
    """The entries of one of `obj`'s adjacencies, as dicts of link and property values. (Case study 2.)

    The object's own link is implied, so it is not included. Reading goes through a builder started from `obj`: the
    builder is a visitor, and visiting is how anything is read without knowing the schema in advance. The builder is
    never finalized, so nothing changes.
    """
    rows = []

    def read(entry):
        row = {}
        entry.links(lambda link: link.target(lambda target: row.__setitem__(link.name(), target)))
        entry.properties(
            lambda prop: prop.value(lambda v: v.as_native(lambda n: row.__setitem__(prop.name(), n.get())))
        )
        rows.append(row)

    Proxies.store_of(obj).builder(obj.schema_name(), obj).adjacency(adjacency, lambda a: a.entries(read))
    return rows


def remove_entries(obj, adjacency, where):
    """Removes the entries of `obj`'s adjacency for which `where(row)` is true; `row` is as returned by `entries`.
    (Case study 3.)"""

    def visit(a):
        doomed = []

        def check(entry):
            row = {}
            entry.links(lambda link: link.target(lambda target: row.__setitem__(link.name(), target)))
            entry.properties(
                lambda prop: prop.value(lambda v: v.as_native(lambda n: row.__setitem__(prop.name(), n.get())))
            )
            if where(row):
                doomed.append(entry)

        a.entries(check)
        for entry in doomed:
            a.remove(entry)

    return Proxies.store_of(obj).builder(obj.schema_name(), obj).adjacency(adjacency, visit).update()
