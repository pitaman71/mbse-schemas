# Helpers shared by the examples.

import json
from collections.abc import Iterator
from contextlib import contextmanager


def entries(schema, obj, adjacency):
    """The entries of `obj`'s adjacency, read through the visitor protocol: each a dict of the other links' objects and
    the properties' values that are set."""
    read = getattr(obj, adjacency)
    me = read.as_schema().me
    rows = []
    for entry in read:
        row = {link: getattr(entry, link) for link in entry.as_schema().links if link != me}
        for name in entry.as_schema().properties:
            value = getattr(entry, name).get()
            if value is not None:
                row[name] = value
        rows.append(row)
    return rows


def same_graph(a, b):
    """Snapshot equality up to entry order, and the order objects are written in.

    Objects are written in first-reference order, which depends on entry order, and entries form a set whose order
    depends on history. Each object is identified here by its own property values, which the examples keep unique
    within a graph, rather than by its path or number.
    """

    def canonical(graph):
        symbol = lambda path: json.dumps(path, sort_keys=True)
        called = lambda obj: obj['path'] if 'path' in obj else {'n': obj['n']}  # a path, or a counted object's number
        objects = {symbol(called(obj)): obj['properties'] for obj in graph['objects']}
        labels = {
            at: repr(sorted((k, v) for k, v in obj.items() if not isinstance(v, list)))
            for at, obj in objects.items()
        }
        assert len(set(labels.values())) == len(labels), 'objects must have distinct property values'

        def entry(e):
            return repr(sorted((k, labels[symbol(v['$ref'])] if isinstance(v, dict) else v) for k, v in e.items()))

        return labels[symbol(graph['root'])], {
            labels[at]: {k: sorted(map(entry, v)) for k, v in obj.items() if isinstance(v, list)}
            for at, obj in objects.items()
        }

    return canonical(a) == canonical(b)


@contextmanager
def raises(*errors: type[BaseException]) -> Iterator[None]:
    try:
        yield
    except errors:
        return
    raise AssertionError(f"expected one of {[e.__name__ for e in errors]}")
