# Helpers shared by the examples.

from collections.abc import Iterator
from contextlib import contextmanager

from mbse.Schemas.Framework import Plain, Proxies, Reachable


def entries(schema, obj, adjacency):
    """The entries of `obj`'s adjacency, with references resolved to objects.

    Reading entries back is not part of the API yet, so this reads them from a Reachable snapshot: its symbols are
    assigned in first-reference order, the same order `Reachable.of` returns.
    """
    graph = Plain.ToPlain(Proxies.store_of(obj)).Reachable(schema, obj)
    objects = Reachable.of(obj)

    def resolve(value):
        return objects[int(value['$ref'][1:])] if isinstance(value, dict) else value

    return [{k: resolve(v) for k, v in e.items()} for e in graph['objects'][graph['root']].get(adjacency, [])]


def same_graph(a, b):
    """Snapshot equality up to symbol numbering and entry order.

    Symbols are numbered in first-reference order, which depends on entry order, and entries form a set whose order
    depends on history. Each object is identified here by its own property values instead, which the examples keep
    unique within a graph.
    """

    def canonical(graph):
        objects = graph['objects']
        labels = {
            symbol: repr(sorted((k, v) for k, v in obj.items() if not isinstance(v, list)))
            for symbol, obj in objects.items()
        }
        assert len(set(labels.values())) == len(labels), 'objects must have distinct property values'

        def entry(e):
            return repr(sorted((k, labels[v['$ref']] if isinstance(v, dict) else v) for k, v in e.items()))

        return labels[graph['root']], {
            labels[symbol]: {k: sorted(map(entry, v)) for k, v in obj.items() if isinstance(v, list)}
            for symbol, obj in objects.items()
        }

    return canonical(a) == canonical(b)


@contextmanager
def raises(*errors: type[BaseException]) -> Iterator[None]:
    try:
        yield
    except errors:
        return
    raise AssertionError(f"expected one of {[e.__name__ for e in errors]}")
