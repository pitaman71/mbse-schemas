<!-- nav -->
[← Open-world modeling](OPEN_WORLD.md) · [Home](../README.md) · [Schema extension →](SCHEMA_EXTENSION.md)

# Notation

*REF* denotes Schemas.OfObject
*REL* dentoes Schemas.OfRelation
*VAL* dentoes Schemas.OfAny

# Modeling

`mbse-schemas/Parametrics` is defined normal schemas and one extension.

REF `mbse-schemas/Schemas.OfParameter` - just a name and a description
PROPS `mbse-schemas/Schemas.OfParameter.{name, description}`
REF `mbse-schemas/Parametrics.OfParameters` - nest of named parameters
REL `mbse-schemas/Parametrics.Defines(parameters, name, parameter)`
REL `mbse-schemas/Parametrics.ForValue(param: Schemas.OfParameter, schema: Schemas.OfAny)` - parameter that can bind to a value (*:1)
REL `mbse-schemas/Parametrics.ForObject(param: Schemas.OfParameter, schema: Schemas.OfObject)` - parameter that can bind to an object ref (*:1)

REL `mbse-schemas/Parametrics.HasParameters(defn, params: Schemas.OfParameters)` # unique in both directions
PROPS `mbse-schemas/Parametrics.value`
REL `mbse-schemas/Parametrics.BindsValue(defn, param: Schemas.OfParameter, value)`
REL `mbse-schemas/Parametrics.BindsObject(defn, param: Schemas.OfParameter, obj_ref)`

# Schema Parameters

`mbse-schemas/Parametrics.install` extends `Schemas.OfX` with three adjacencies each:
- `Schemas.OfX.parameters` to `Parametrics.HasParameters`
- `Schemas.OfX.values` to `Parametrics.BindsValue`
- `Schemas.OfX.objects` to `Parametrics.BinddsObject`

# Expression Parameters

TBD

---

<!-- nav -->
[← Open-world modeling](OPEN_WORLD.md) · [Home](../README.md) · [Schema extension →](SCHEMA_EXTENSION.md)
