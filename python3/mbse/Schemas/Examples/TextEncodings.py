# Text encodings example: JSON and YAML round trips over edge values and a small graph. Requires PyYAML.
#
# JSON and YAML are thin encodings of Plain data, so all three produce the same plain data. Weather stations and
# readings use ISO 8601 timestamps and WMO station identifiers.

import json
import math

import yaml

from mbse.Schemas.Framework import JSON, YAML, Plain, Proxies, Schemas, Validators
from mbse.Schemas.Framework.Errors import DecodeError
from mbse.Schemas.Examples._support import raises, same_graph

# --- Schemas ---

Reading = (
    Schemas.OfObject.Builder().ref()
    .properties(
        lambda prop: prop.name('observed').of(lambda t: t.as_native(str)),  # ISO 8601, e.g. '2026-09-28T12:00:00Z'
        lambda prop: prop.name('value').of(lambda t: t.as_native(float)),
        lambda prop: prop.name('quality').of(lambda t: t.as_native(int)),
        lambda prop: prop.name('valid').of(lambda t: t.as_native(bool)),
        lambda prop: prop.name('raw').of(lambda t: t.as_native(bytes)),
        lambda prop: prop.name('note').of(lambda t: t.as_native(str)),
    )
    .create()
)
Station = (
    Schemas.OfObject.Builder().ref()
    .properties(
        lambda prop: prop.name('wmo_id').of(lambda t: t.as_native(str)),  # e.g. '03772'; leading zeros matter
        lambda prop: prop.name('name').of(lambda t: t.as_native(str)),
    )
    .create()
)
Readings = (
    Schemas.OfRelation.Builder()
    .links('station', 'reading')
    .properties(lambda prop: prop.name('sensor').of(lambda t: t.as_native(str)))
    .unique('station', 'sensor')  # each reading comes from one sensor of one station
    .create()
)
Station = Schemas.OfObject.Builder(Station).relations(lambda adj: adj.name('readings').of(Readings).me('station')).update()
Reading = Schemas.OfObject.Builder(Reading).relations(lambda adj: adj.name('station').of(Readings).me('reading')).update()

for name, schema in [('Reading', Reading), ('Station', Station), ('Readings', Readings)]:
    Proxies.register(name, schema)
Builders = Proxies.Builders
validate = Validators.Validate(Proxies.Builders)
from_json = JSON.FromJSON(Proxies.Builders)
from_yaml = YAML.FromYAML(Proxies.Builders)

# --- Floats at their edges, through every encoding ---

for value in [0.0, -0.0, 1e308, 5e-324, 0.1, math.inf, -math.inf, math.nan]:
    reading = Builders.Reading().value(value).create()
    for back in (
        Plain.FromPlain(Proxies.Builders)(Reading, Plain.ToPlain(Reading, reading)),
        from_json(Reading, JSON.ToJSON(Reading, reading)),
        from_yaml(Reading, YAML.ToYAML(Reading, reading)),
    ):
        if math.isnan(value):
            assert math.isnan(back.value)
        else:
            assert back.value == value and math.copysign(1, back.value) == math.copysign(1, value)

# Non-finite floats have a plain form, so JSON output stays strict (no NaN / Infinity literals).
text = JSON.ToJSON(Reading, Builders.Reading().value(math.nan).create())
assert '"NaN"' in text and json.loads(text, parse_constant=lambda c: 1 / 0)

# --- Every native type at once, and the three encodings agree ---

sample = (
    Builders.Reading()
    .observed('2026-09-28T12:00:00Z')
    .value(-0.0)
    .quality(2**70)  # unbounded in Python; other languages may need a wider type
    .valid(False)
    .raw(b'\x00\xff' * 4)
    .note('日本語 🚀 \x00 "quoted" \\ back\nsecond line')
    .create()
)
plain = Plain.ToPlain(Reading, sample)
assert JSON.loads(JSON.ToJSON(Reading, sample)) == plain
assert YAML.loads(YAML.ToYAML(Reading, sample)) == plain
assert JSON.loads(JSON.ToJSON(Reading, sample, indent=2)) == plain  # formatting does not change content

for back in (from_json(Reading, JSON.ToJSON(Reading, sample)), from_yaml(Reading, YAML.ToYAML(Reading, sample))):
    assert (back.observed, back.quality, back.valid, back.raw, back.note) == (
        sample.observed, sample.quality, sample.valid, sample.raw, sample.note)
    assert validate(Reading, back) == []

# --- Strings that YAML readers like to misread ---

tricky = ['yes', 'No', 'on', 'OFF', 'true', 'null', '~', '', '010', '0o17', '0x1F', '1e3', '1_000', '1:30',
          '2026-09-01', '.inf', '.nan', 'NaN', 'Infinity', '-0.0', ' lead', 'trail ', 'a: b', '- dash', '#hash',
          'x #y', '"dq"', "'sq'", '@at', '`tick', '%pct', '!bang', '&amp', '*star', '|', '>', '{}', '[]', '<<']
for note in tricky:
    reading = Builders.Reading().note(note).create()
    text = YAML.ToYAML(Reading, reading)
    assert from_yaml(Reading, text).note == note, note
    # The output is also read correctly by a stock YAML 1.1 loader.
    assert yaml.safe_load(text) == Plain.ToPlain(Reading, reading), note

# WMO identifiers keep their leading zeros in both encodings.
paris = Builders.Station().wmo_id('07149').name('Paris-Orly').create()
assert from_json(Station, JSON.ToJSON(Station, paris)).wmo_id == '07149'
assert from_yaml(Station, YAML.ToYAML(Station, paris)).wmo_id == '07149'

# --- Hand-written YAML follows the YAML 1.2 core schema ---

written = """
root: s0
objects:
  s0:
    observed: 2026-09-28T12:00:00Z   # unquoted, but stays a string
    quality: 010                     # ten, not eight
    value: .inf
    valid: true
    note: 1:30                       # a string, not ninety
"""
reading = from_yaml(Reading, written)
assert (reading.observed, reading.quality, reading.value, reading.valid, reading.note) == (
    '2026-09-28T12:00:00Z', 10, math.inf, True, '1:30')

# 'yes' is a string in YAML 1.2, so it is not accepted for a bool.
with raises(DecodeError):
    from_yaml(Reading, "root: s0\nobjects:\n  s0:\n    valid: yes\n")

# --- Malformed text is rejected ---

for bad in ['{"root": "s0", "objects": {"s0": {"value": NaN}}}',  # NaN literal: not JSON
            '{"root": "s0", "root": "s1", "objects": {}}',  # duplicate key
            '{"root": "s0", "objects": ',  # truncated
            '{"root": "s0", "objects": {"s0": {"value": "nan"}}}']:  # only 'NaN', 'Infinity', '-Infinity'
    with raises(DecodeError):
        from_json(Reading, bad)

for bad in ['root: s0\nroot: s1\nobjects: {}',  # duplicate key
            'root: s0\nobjects:\n  s0:\n    raw: !!binary AAAA',  # tagged binary: not plain data
            '1: x',  # non-string key
            '---\nroot: s0\n---\nroot: s1',  # two documents
            'root: [unclosed']:
    with raises(DecodeError):
        from_yaml(Reading, bad)

# --- A graph through each encoding ---

lyon = (
    Builders.Station()
    .wmo_id('07480')
    .name('Lyon-Saint-Exupéry')
    .readings(lambda x: x.reading(lambda r: r.observed('2026-09-28T06:00:00Z').value(11.5).valid(True)).sensor('temp'))
    .readings(lambda x: x.reading(lambda r: r.observed('2026-09-28T06:00:00Z').value(71.0).valid(True)).sensor('rh'))
    .create()
)
graph = Plain.ToPlain.Reachable(Station, lyon)
for text, decode in [(JSON.ToJSON.Reachable(Station, lyon), from_json.Reachable),
                     (YAML.ToYAML.Reachable(Station, lyon), from_yaml.Reachable)]:
    restored = decode(Station, text)
    assert restored is not lyon and restored.name == 'Lyon-Saint-Exupéry'
    assert same_graph(Plain.ToPlain.Reachable(Station, restored), graph)
    assert validate.Reachable(Station, restored) == []

# A single-object snapshot leaves references unresolved, in any encoding.
with raises(DecodeError):
    from_json(Station, JSON.ToJSON(Station, lyon))
with raises(DecodeError):
    from_yaml(Station, YAML.ToYAML(Station, lyon))

print('TextEncodings: all checks passed')
