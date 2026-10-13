# Objects store (entity storage)

How a plugin stores entities behind handler tags, with an `Array:` keyed by
handler and an optional `Trie:` for key lookup.

## Contents

- [Entity files under `Objects/`](#entity-files-under-objects)
- [Handler tags](#handler-tags)
- [Struct fields](#struct-fields)
- [Storage](#storage)
- [Key lookup](#key-lookup)
- [Initialization](#initialization)
- [Encapsulation](#encapsulation)
- [Gotchas](#gotchas)
- [Checklist](#checklist)

## Entity files under `Objects/`

When the plugin keeps a store of entities, whether or not it exposes them to the
outside, all entity implementations go under `SomePlugin/Objects/*.inc`.
Grouping into subfolders inside `Objects` is allowed:

```text
SomePlugin/Objects/
    SomeObject.inc
    Weapons/
        Weapon.inc
```

## Handler tags

An entity's handler is a tagged value. Declare the tag as an enum whose first
member is the invalid sentinel:

```pawn
enum T_SomeObject
{
    Invalid_SomeObject = INVALID_HANDLE
}
```

`INVALID_HANDLE` is `-1`. When `-1` does not fit the value's range, use zero
instead:

```pawn
enum T_SomeObject
{
    Invalid_SomeObject = 0
}
```

A prefix in the tag name is allowed when the tag is published in a shared
include, so tags from different modules do not collide. The `T_` and `Invalid_`
naming follows `amxx-pawn-style`; this file only fixes the sentinel and the
value's storage role, not the names.

## Struct fields

When an entity has several fields, declare a struct enum and store it in an
`Array:`. The `_:` on the enum is mandatory, or the compiler complains when the
int-typed members are used as plain cells:

```pawn
enum _:S_SomeObject
{
    SomeObject_Name[32],
    SomeObject_Score
}
```

Names follow `amxx-pawn-style` (struct role `S_`, member prefix); this example
shows only the storage shape.

## Storage

The store is an `Array:` whose element index is the entity's handler and whose
value is the entity itself. The handler is the number explicitly cast to the
`T_SomeObject` tag:

```pawn
static Array:SomeObjects;

new entityData[S_SomeObject];
// ... fill entityData ...
new T_SomeObject:handler = T_SomeObject:ArrayPushArray(SomeObjects, entityData);
// the pushed index is the handler; SomeObjects[handler] is the entity
```

The handler is the pushed element's position, cast to the tag, so a handler
round-trips back to its entity by indexing the array.

## Key lookup

When entities must be found by key, keep a nearby `Trie:` whose key is the
entity key and whose value is the entity handler (the array index):

```pawn
static Trie:SomeObjectByKey;

// Trie cells are untagged, so keep the handler here as a plain index.
new handler = ArrayPushArray(SomeObjects, entityData);
TrieSetCell(SomeObjectByKey, key, handler);

// later, resolve a key back to an entity
new handler;
if (TrieGetCell(SomeObjectByKey, key, handler)) {
    // SomeObjects[handler] is the entity
}
```

## Initialization

The store is initialized from the `.sma` by a function in the object's file,
named `<object type>_Init()`. In it the `Array` and `Trie` are created and, when
needed, other hooks are set up:

```pawn
SomeObject_Init() {
    static bool:isInited = false;
    if (isInited) {
        return;
    }
    isInited = true;

    SomeObjects = ArrayCreate(S_SomeObject);
    SomeObjectByKey = TrieCreate();
    // set up any other hooks ...
}
```

```pawn
// SomePlugin.sma

public plugin_precache() {
    SomeObject_Init();
}
```

If the component depends on an external API that needs initialization, its
`_Init` initializes that API too, even if the `.sma` or another component
already did. This keeps restructuring safe: a component never depends on someone
else having wired its prerequisites.

When creating objects is available through the API, `_Init` calls the
corresponding multi-forward. The registry is guaranteed ready to accept
registrations inside that call and stays ready afterward, so that forward is the
documented place to register the store's objects:

```pawn
SomeObject_Init() {
    // ... create the store ...

    ExternalAPI_Init(); // initialize this component's own prerequisite
    SomeObject_OnCreateRequest(); // published objects register inside this call
}
```

## Encapsulation

The `Array` and `Trie` MUST be `static` in these files. Every interaction with
entities through their handlers, even from elsewhere in the plugin, goes through
functions defined in this file:

```pawn
static Array:SomeObjects;

T_SomeObject:SomeObject_Create(const key[]) {
    new entityData[S_SomeObject];
    // ... fill entityData ...

    new handler = ArrayPushArray(SomeObjects, entityData);
    TrieSetCell(SomeObjectByKey, key, handler);

    return T_SomeObject:handler;
}

bool:SomeObject_IsValid(const T_SomeObject:handler) {
    return handler != Invalid_SomeObject;
}
```

If the handler tag and/or the struct are already published in a shared include,
do not duplicate them here. Explicitly include that file instead:

```pawn
#include "SomePlugin_Shared" // provides T_SomeObject and S_SomeObject
```

## Gotchas

- **`_:` on the struct enum is mandatory.** Without it, the int-typed members
  trigger a tag mismatch when used as plain cells.
- **`INVALID_HANDLE` is `-1`.** Use it as the sentinel only when `-1` cannot be a
  valid handler; otherwise use `0`.
- **The store stays `static`.** A non-static `Array` / `Trie` lets another file
  read or mutate the store directly and breaks the encapsulation.
- **Prerequisites are re-initialized, not assumed.** A component's `_Init` calls
  the external API's init even if it looks already done; initialization is
  idempotent, so the extra call is safe.
- **The tag and struct are not duplicated.** When a shared include publishes
  them, include it; do not redeclare.

## Checklist

- [ ] Entity implementations live under `Objects/`.
- [ ] Each handler tag is an enum with an `Invalid_*` sentinel
      (`INVALID_HANDLE`, or `0` when `-1` does not fit).
- [ ] Multi-field entities use `enum _:S_<Name>` stored in an `Array:`.
- [ ] The `Array:` index is the handler cast to the tag; key lookups use a
      `Trie:`.
- [ ] The store is created in `<object type>_Init()` called from the `.sma`.
- [ ] The component's own external prerequisites are initialized in `_Init`.
- [ ] `Array` / `Trie` are `static`; all handler access goes through functions.
- [ ] A shared include provides the tag and struct; it is included, not
      duplicated.
