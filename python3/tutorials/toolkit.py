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


def elements(prop):
    """The elements of the container a property holds, as (index, element) pairs in order: each element a scalar, or
    a visitor where it is not one. (Case study 2.)

    A property's visitor holds its value, here read as a container; the container's elements are each visited
    through their own visitor, read as a scalar first.
    """
    pairs, found = [], []
    prop.as_value(lambda v: v.as_container(lambda c: c.as_entries(pairs.extend)))
    for index, element in pairs:
        value = []
        element.as_scalar(lambda s: value.append(s.get()) or s)
        if value[0] is None:
            element.as_object(lambda o: value.__setitem__(0, o) or o)
        found.append((index, value[0]))
    return found


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
