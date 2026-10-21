# Helpers shared by the examples.

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


def members(document):
    """A document's objects, by symbol (its number, the root's '0'): each one's properties, as its spec sets them, and
    its entries, as its spec inserts them, each its links' references and its properties' values."""
    pattern = document['mutations'][0]['upsert']['exists'][0]
    out = {symbol: {} for symbol in pattern['symbols']}
    for item in pattern.get('spec', []):
        for symbol, given in item.items():
            for member in given:
                (kind, body), = member.items()
                if kind == 'as_property':
                    out[symbol][body['name']] = body['mutations'][0]['set']['value']
                    continue
                out[symbol][body['name']] = [
                    {part['name']: part['mutations'][0]['set'].get('value', part['mutations'][0]['set'].get('ref'))
                     for verb in entry['mutations'] for part in verb.values()}
                    for entry in body['mutations'][0]['insert']['entries']]
    return out


def schema_names(document):
    """The registered names of the schemas of a document's objects, by symbol: each read off its path."""
    names = {}
    for symbol, held in document['mutations'][0]['upsert']['exists'][0]['symbols'].items():
        step, parts = held['schema'][0]['$ref']['next'], []
        while 'entry' in step:
            parts.append(step['entry']['properties']['name'])
            step = step['entry']['next']
        names[symbol] = '.'.join(parts)
    return names


@contextmanager
def raises(*errors: type[BaseException]) -> Iterator[None]:
    try:
        yield
    except errors:
        return
    raise AssertionError(f"expected one of {[e.__name__ for e in errors]}")
