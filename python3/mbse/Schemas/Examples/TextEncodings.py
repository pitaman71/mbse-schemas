# Text encodings example: JSON and YAML round trips over edge values and a small graph. Requires PyYAML.
#
# JSON and YAML are thin encodings of Plain data, so all three produce the same plain data. Weather stations and
# readings use ISO 8601 timestamps and WMO station identifiers.

import json
import math

import yaml

from mbse.Schemas.Framework import JSON, YAML, Builders, Plain, Validators
from mbse.Schemas.Framework.Errors import DecodeError
from mbse.Schemas.Examples._support import raises


# --- Schemas ---


def install(txn):
    """The weather schemas, defined in the store a transaction writes (`store.transaction(install)`): readings and the
    stations they come from, each found by its name, else made."""
    S = txn.Schemas  # the store's own schemas, by name
    return txn.uid('examples.text_encodings/1').mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({'Reading': S.OfObject, 'Station': S.OfObject, 'Readings': S.OfRelation})
        .spec([
            lambda _: _.Reading.name('Reading').ref(True).properties({
                'observed': S.OfStr,  # ISO 8601, e.g. '2026-09-28T12:00:00Z'
                'value': S.OfFloat,
                'quality': S.OfInt,
                'valid': S.OfBool,
                'raw': S.OfBytes,
                'note': S.OfStr,
            }).adjacencies({'station': lambda a: a.relation([_.Readings]).me('reading')}),
            lambda _: _.Station.name('Station').ref(True).properties({
                'wmo_id': S.OfStr,  # e.g. '03772'; leading zeros matter
                'name': S.OfStr,
            }).adjacencies({'readings': lambda a: a.relation([_.Readings]).me('station')}),
            lambda _: _.Readings.name('Readings').links([
                lambda t: t.name('station'),
                lambda t: t.name('reading'),
            ]).properties({'sensor': S.OfStr}).uniques(['station', 'sensor']),  # each reading from one sensor of one station
        ])]))])


store = Builders.Store()
store.transaction(install)  # every write to a store is made within a transaction, all or nothing
Reading, Station = store.registered('Reading'), store.registered('Station')

validate = Validators.Validate(store)
from_json = JSON.FromJSON(store)
from_yaml = YAML.FromYAML(store)

# --- Floats at their edges, through every encoding ---

with store.transaction():  # each reading written, and read back, within one transaction: a decoder joins it
    for value in [0.0, -0.0, 1e308, 5e-324, 0.1, math.inf, -math.inf, math.nan]:
        reading = store.Reading(lambda r: r.value(value))
        for back in (
            Plain.FromPlain(store)(Reading, Plain.ToPlain(store)(Reading, reading)),
            from_json(Reading, JSON.ToJSON(store)(Reading, reading)),
            from_yaml(Reading, YAML.ToYAML(store)(Reading, reading)),
        ):
            if math.isnan(value):
                assert math.isnan(back.value.get())
            else:
                assert back.value.get() == value and math.copysign(1, back.value.get()) == math.copysign(1, value)

# Non-finite floats have a plain form, so JSON output stays strict (no NaN / Infinity literals).
with store.transaction():
    text = JSON.ToJSON(store)(Reading, store.Reading(lambda r: r.value(math.nan)))
assert '"NaN"' in text and json.loads(text, parse_constant=lambda c: 1 / 0)

# --- Every scalar type at once, and the three encodings agree ---

with store.transaction():
    sample = store.Reading(lambda r: (
        r
        .observed('2026-09-28T12:00:00Z')
        .value(-0.0)
        .quality(2**70)  # unbounded in Python; other languages may need a wider type
        .valid(False)
        .raw(b'\x00\xff' * 4)
        .note('日本語 🚀 \x00 "quoted" \\ back\nsecond line')
    ))
plain = Plain.ToPlain(store)(Reading, sample)
assert JSON.loads(JSON.ToJSON(store)(Reading, sample)) == plain
assert YAML.loads(YAML.ToYAML(store)(Reading, sample)) == plain
assert JSON.loads(JSON.ToJSON(store)(Reading, sample, indent=2)) == plain  # formatting does not change content

for back in (from_json(Reading, JSON.ToJSON(store)(Reading, sample)), from_yaml(Reading, YAML.ToYAML(store)(Reading, sample))):
    assert (back.observed.get(), back.quality.get(), back.valid.get(), back.raw.get(), back.note.get()) == (
        sample.observed.get(), sample.quality.get(), sample.valid.get(), sample.raw.get(), sample.note.get())
    assert validate(Reading, back) == []

# --- Strings that YAML readers like to misread ---

tricky = ['yes', 'No', 'on', 'OFF', 'true', 'null', '~', '', '010', '0o17', '0x1F', '1e3', '1_000', '1:30',
          '2026-09-01', '.inf', '.nan', 'NaN', 'Infinity', '-0.0', ' lead', 'trail ', 'a: b', '- dash', '#hash',
          'x #y', '"dq"', "'sq'", '@at', '`tick', '%pct', '!bang', '&amp', '*star', '|', '>', '{}', '[]', '<<']
with store.transaction():
    for note in tricky:
        reading = store.Reading(lambda r: r.note(note))
        text = YAML.ToYAML(store)(Reading, reading)
        assert from_yaml(Reading, text).note.get() == note, note
        # The output is also read correctly by a stock YAML 1.1 loader.
        assert yaml.safe_load(text) == Plain.ToPlain(store)(Reading, reading), note

# WMO identifiers keep their leading zeros in both encodings.
with store.transaction():
    paris = store.Station(lambda s: s.wmo_id('07149').name('Paris-Orly'))
assert from_json(Station, JSON.ToJSON(store)(Station, paris)).wmo_id.get() == '07149'
assert from_yaml(Station, YAML.ToYAML(store)(Station, paris)).wmo_id.get() == '07149'

# --- Hand-written YAML follows the YAML 1.2 core schema ---


def written(*members):
    """A hand-written YAML document of one reading, counted: the symbol '0', each member a property set, its value given
    as YAML text."""
    reading = "{singleton: ., next: {entry: {i: schemas, o: '', properties: {name: Reading}, next: {target: {}}}}}"
    return ("mutations:\n- upsert:\n    exists:\n    - symbols:\n        '0':\n          schema:\n          - $ref: " + reading
            + "\n      spec:\n      - '0':\n" + "".join(f"        - as_property:\n            name: {name}\n            mutations:\n"
                                                         f"            - set:\n                value: {value}\n"
                                                         for name, value in members))


reading = from_yaml(Reading, written(
    ('observed', '2026-09-28T12:00:00Z   # unquoted, but stays a string'),
    ('quality', '010                     # ten, not eight'),
    ('value', '.inf'),
    ('valid', 'true'),
    ('note', '1:30                       # a string, not ninety'),
))
assert (reading.observed.get(), reading.quality.get(), reading.value.get(), reading.valid.get(), reading.note.get()) == (
    '2026-09-28T12:00:00Z', 10, math.inf, True, '1:30')

# 'yes' is a string in YAML 1.2, so it is not accepted for a bool.
with raises(DecodeError):
    from_yaml(Reading, written(('valid', 'yes')))

# --- Malformed text is rejected ---

with store.transaction():
    good = JSON.ToJSON(store)(Reading, store.Reading(lambda r: r.value(1.5)))
for bad in [good.replace('1.5', 'NaN', 1),  # not JSON
            '{"mutations": [], "mutations": []}',  # duplicate key
            good[:40],  # truncated
            good.replace('1.5', '"nan"', 1)]:  # only 'NaN', 'Infinity', '-Infinity'
    with raises(DecodeError):
        from_json(Reading, bad)

for bad in ["mutations: []\nmutations: []",  # duplicate key
            written(('raw', '!!binary AAAA')),  # tagged binary: not plain data
            '1: x',  # non-string key
            "---\nmutations: []\n---\nmutations: []",  # two documents
            'mutations: [unclosed']:
    with raises(DecodeError):
        from_yaml(Reading, bad)

# --- A graph through each encoding ---

with store.transaction():
    lyon = store.Station(lambda s: (
        s
        .wmo_id('07480')
        .name('Lyon-Saint-Exupéry')
        .readings(lambda a: a.insert(lambda x: x.reading(lambda r: r.observed('2026-09-28T06:00:00Z').value(11.5).valid(True)).sensor('temp')))
        .readings(lambda a: a.insert(lambda x: x.reading(lambda r: r.observed('2026-09-28T06:00:00Z').value(71.0).valid(True)).sensor('rh')))
    ))
graph = Plain.ToPlain(store).Reachable(Station, lyon)
for text, decoder in [(JSON.ToJSON(store).Reachable(Station, lyon), JSON.FromJSON),
                      (YAML.ToYAML(store).Reachable(Station, lyon), YAML.FromYAML)]:
    elsewhere = Builders.Store()  # read into another store: new objects of the same graph
    Plain.FromPlain(elsewhere).Snapshot(Plain.ToPlain(store).Snapshot())  # the same schemas, its own: a store's snapshot writes them
    restored = decoder(elsewhere).Reachable(elsewhere.Station, text)
    assert restored is not lyon
    assert str(restored.name) == 'Lyon-Saint-Exupéry'
    assert Plain.ToPlain(elsewhere).Reachable(elsewhere.Station, restored) == graph
    assert Validators.Validate(elsewhere).Reachable(elsewhere.Station, restored) == []

# An object's document holds it alone, in any encoding: lyon's, which links counted readings, is refused.
with raises(ValueError):
    JSON.ToJSON(store)(Station, lyon)
with raises(ValueError):
    YAML.ToYAML(store)(Station, lyon)

print('TextEncodings: all checks passed')
