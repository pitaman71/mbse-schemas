<!-- nav -->
[← Meta-schemas overhaul](META_SCHEMAS.md) · [Home](../README.md) · [Open-world modeling →](OPEN_WORLD.md)

# Reference Object Identity

Every reference object has an identity, denoted over the wire as:

```a.b.c/instance_name```

When an object is built, `Visitors.OfObject.as_identity` may be called to set the identity:

```
# any named reference object can serve as a namespace
# create `crm` as a root level namespace
store.Schemas.OfModule(lambda obj: obj.as_identity(lambda id: id.suffix('crm'))) # package name, path is the store itself

# create 'Contacts' directory under `crm.`
store.Schemas.OfModule(lambda crm: crm.as_identity(lambda id: id.suffix('Contacts').module(store.Instances.crm))) # directory

# create `Anna Baker`, allow regex or UUID for identity suffix
store.crm.Contact(lambda contact: contact.name('Anna Baker').as_identity(lambda id: id.module(store.Instances.crm.Contacts)))
```

- Visitors.OfObject.as_identity only has meaning for reference objects and will raise if called on a value object or a singleton reference
- If the schema declares a singleton name (`.singleton("foo")`) that is exactly the identity suffix and the path is the schema itself
- if Visitors.OfObject.as_identity is called and a identity suffix is provided, that name takes precedence on a new/cloned object
- ... if Visitors.OfObject.as_identity is called and a identity suffix is not provided, but the schema provides a pattern for reference names `ref` (`.ref("FEA-(\d+\d\d)")`) that is used to generate the identity suffix on a new/cloned object
- ... if Visitors.OfObject.as_identity is not called or an identity suffix is not provided, reference objects declared with `.ref()` (no pattern) have a UUID on creation by `.create()` or `.clone()`
- wire format for an object reference in all cases is `path/suffix` 
- validate will refuse a schema with both a singleton name and a ref naming pattern

```python
Feature = (
  Schemas.OfObject.Builder()
  .ref(r'FEA-(\d+\d\d)')
  ...create()
)

# FEA-XXX will be assigned
store.Feature(lambda fe: fe.title('Has 88 Keys').description('ipso lorum comencium gateo est')) 
```

- The choice of formatted name and registration with the implied directory must happen automatically anytime a named reference object is created or copied
- programs can obtain the identity of any reference object via `Visitors.OfObject.as_identity`
- programs can find a specific reference object with `store.Instances.path.as_instance(suffix)`
- there is one directory store per module within each store: a module path's suffixes are unique across every schema
  whose objects it names
- allocated IDs are strictly increasing (even in the presence of yet to be designed deletions)
- repeated appearance of the same ID (path and suffix) are interpreted as update of the existing object by the visitor, if update is allowed. This is particularly important for snapshot loading and journal loading

## Decided

As the user decided (2026-10-16), on the questions put to them:

1. A suffix is looked up by `as_instance`: "yes use as_instance". A suffix need not be an identifier (`FEA-001`, `Anna
   Baker`, a UUID), so `store.Instances.<path>.as_instance(suffix)` takes it as a string: the one place an object's
   identity references it (mbse-basis P-015, Exceptions); the path is attributes.
2. Namespaces are modules: "Use Schemas.OfModule instead of Schemas.Namespace".
3. A schema is an object's module path where none is given: "yes the schema itself is the default container" (the
   identity's path is a module path, "it was never container path").
4. On the wire: "use `Schema@Path/Suffix` and omit `Schema@` when it can be inferred from context".
5. "Programs cannot set or modify their identity": "yeah that rule is completely gone".
6. A suffix given for a schema with a `ref` pattern that it does not match: "raise".
7. `as_identity`'s callback visits the identity: "yes, Schemas.OfIdentity now is an object" (its `suffix` and its
   module path, `module`).
8. `Schema@` is written only where an object is created, in `Mutations.OfObject.Exists`, which must know what to
   build; everywhere else `ModulePath/Suffix` references the object, "the path is sufficient to reference the object
   without the schema", since "there is one directory store per module within each store" (2026-10-16). This settles
   4's "when it can be inferred from context".

---

<!-- nav -->
[← Meta-schemas overhaul](META_SCHEMAS.md) · [Home](../README.md) · [Open-world modeling →](OPEN_WORLD.md)
