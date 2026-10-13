"""Helpers built in the tutorials, collected so later case studies can import them.

Each function is developed and explained in the case study named in its docstring.
"""

from mbse.Schemas.Framework import Proxies


def entries(obj, adjacency):
    """The entries of one of `obj`'s adjacencies, as dicts of link and property values. (Case study 2.)

    The object's own link is implied, so it is not included. An adjacency is a member of the object, a visitor that
    iterates its entries; an entry's links are members giving the linked object, and its properties members whose
    `get()` gives the value. The schema is read through `as_schema()`, so this works for any relation.
    """
    read = getattr(obj, adjacency)
    me = read.as_schema().me
    rows = []
    for entry in read:
        schema = entry.as_schema()
        row = {link: getattr(entry, link) for link in schema.links if link != me}
        for name in schema.properties:
            value = getattr(entry, name).get()
            if value is not None:
                row[name] = value
        rows.append(row)
    return rows


def remove_entries(obj, adjacency, where):
    """Removes the entries of `obj`'s adjacency for which `where(row)` is true; `row` is as returned by `entries`.
    (Case study 3.)"""
    doomed = [entry for entry, row in zip(getattr(obj, adjacency), entries(obj, adjacency)) if where(row)]

    def remove(a):
        for entry in doomed:  # an entry given as a value removes the entries equal to it
            a.remove(entry)
        return a

    builder = Proxies.store_of(obj).builder(obj.as_schema().name, obj)
    return getattr(builder, adjacency)(remove).update()
