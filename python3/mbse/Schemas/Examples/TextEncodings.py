# Text encodings example: JSON and YAML round trips over edge values and a small graph. Requires PyYAML.
#
# JSON and YAML are thin encodings of Plain data, so all three produce the same plain data. Weather stations and
# readings use ISO 8601 timestamps and WMO station identifiers.

import json
import math

import yaml

from mbse.Schemas.Framework import JSON, YAML, Builders, Plain, Schemas, Validators
from mbse.Schemas.Framework.Errors import DecodeError
from mbse.Schemas.Examples._support import raises, same_graph


store = Builders.Store()
Text = store.Schemas.OfStr.as_schema()  # the store's own basic scalar

# --- Schemas ---

Reading = store.Schemas.OfObject(lambda o: (
    o
    .name('Reading')
    .ref(True)
    .properties([
        lambda t: t.name('observed').type([Text]),  # ISO 8601, e.g. '2026-09-28T12:00:00Z'
        lambda t: t.name('value').type([store.Schemas.OfFloat]),
        lambda t: t.name('quality').type([store.Schemas.OfInt]),
        lambda t: t.name('valid').type([store.Schemas.OfBool]),
        lambda t: t.name('raw').type([store.Schemas.OfBytes]),
        lambda t: t.name('note').type([Text]),
    ])
))
Station = store.Schemas.OfObject(lambda o: (
    o
    .name('Station')
    .ref(True)
    .properties([
        lambda t: t.name('wmo_id').type([Text]),  # e.g. '03772'; leading zeros matter
        lambda t: t.name('name').type([Text]),
    ])
))
Readings = store.Schemas.OfRelation(lambda r: (
    r
    .name('Readings')
    .links([
        lambda t: t.name('station'),
        lambda t: t.name('reading'),
    ])
    .properties([lambda t: t.name('sensor').type([Text])])
    .uniques(['station', 'sensor'])  # each reading comes from one sensor of one station
))
store.Schemas.OfObject(Station, lambda o: o.adjacencies([lambda t: t.name('readings').relation([Readings]).me('station')]))
store.Schemas.OfObject(Reading, lambda o: o.adjacencies([lambda t: t.name('station').relation([Readings]).me('reading')]))

validate = Validators.Validate(store)
from_json = JSON.FromJSON(store)
from_yaml = YAML.FromYAML(store)

# --- Floats at their edges, through every encoding ---

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
text = JSON.ToJSON(store)(Reading, store.Reading(lambda r: r.value(math.nan)))
assert '"NaN"' in text and json.loads(text, parse_constant=lambda c: 1 / 0)

# --- Every scalar type at once, and the three encodings agree ---

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
for note in tricky:
    reading = store.Reading(lambda r: r.note(note))
    text = YAML.ToYAML(store)(Reading, reading)
    assert from_yaml(Reading, text).note.get() == note, note
    # The output is also read correctly by a stock YAML 1.1 loader.
    assert yaml.safe_load(text) == Plain.ToPlain(store)(Reading, reading), note

# WMO identifiers keep their leading zeros in both encodings.
paris = store.Station(lambda s: s.wmo_id('07149').name('Paris-Orly'))
assert from_json(Station, JSON.ToJSON(store)(Station, paris)).wmo_id.get() == '07149'
assert from_yaml(Station, YAML.ToYAML(store)(Station, paris)).wmo_id.get() == '07149'

# --- Hand-written YAML follows the YAML 1.2 core schema ---

written = """
root: Reading/noon
objects:
  Reading/noon:
    observed: 2026-09-28T12:00:00Z   # unquoted, but stays a string
    quality: 010                     # ten, not eight
    value: .inf
    valid: true
    note: 1:30                       # a string, not ninety
"""
reading = from_yaml(Reading, written)
assert (reading.observed.get(), reading.quality.get(), reading.value.get(), reading.valid.get(), reading.note.get()) == (
    '2026-09-28T12:00:00Z', 10, math.inf, True, '1:30')

# 'yes' is a string in YAML 1.2, so it is not accepted for a bool.
with raises(DecodeError):
    from_yaml(Reading, "root: Reading/noon\nobjects:\n  Reading/noon:\n    valid: yes\n")

# --- Malformed text is rejected ---

for bad in ['{"root": "Reading/a", "objects": {"Reading/a": {"value": NaN}}}',  # NaN literal: not JSON
            '{"root": "Reading/a", "root": "Reading/b", "objects": {}}',  # duplicate key
            '{"root": "Reading/a", "objects": ',  # truncated
            '{"root": "Reading/a", "objects": {"Reading/a": {"value": "nan"}}}']:  # only 'NaN', 'Infinity', '-Infinity'
    with raises(DecodeError):
        from_json(Reading, bad)

for bad in ['root: Reading/a\nroot: Reading/b\nobjects: {}',  # duplicate key
            'root: Reading/a\nobjects:\n  Reading/a:\n    raw: !!binary AAAA',  # tagged binary: not plain data
            '1: x',  # non-string key
            '---\nroot: Reading/a\n---\nroot: Reading/b',  # two documents
            'root: [unclosed']:
    with raises(DecodeError):
        from_yaml(Reading, bad)

# --- A graph through each encoding ---

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
    elsewhere = Builders.Store()  # read into another store: objects of the same identities
    Plain.FromPlain(elsewhere).Snapshot(Plain.ToPlain(store).Snapshot())  # the same schemas, its own: a store's snapshot writes them
    restored = decoder(elsewhere).Reachable(elsewhere.Station, text)
    assert restored is not lyon and restored.as_identity() == lyon.as_identity()
    assert str(restored.name) == 'Lyon-Saint-Exupéry'
    assert same_graph(Plain.ToPlain(elsewhere).Reachable(elsewhere.Station, restored), graph)
    assert Validators.Validate(elsewhere).Reachable(elsewhere.Station, restored) == []

# A single-object snapshot leaves references unresolved, in any encoding.
with raises(DecodeError):
    from_json(Station, JSON.ToJSON(store)(Station, lyon))
with raises(DecodeError):
    from_yaml(Station, YAML.ToYAML(store)(Station, lyon))

print('TextEncodings: all checks passed')
