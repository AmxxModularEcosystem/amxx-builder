# API layer

How a plugin exposes its natives: one file per component, one registration
function per file, and one place that calls them.

## Contents

- [Natives live under `API/`](#natives-live-under-api)
- [One registration function per file](#one-registration-function-per-file)
- [A shared registrar](#a-shared-registrar)
- [Gotchas](#gotchas)
- [Checklist](#checklist)

## Natives live under `API/`

When the plugin exposes an API, all of its natives are declared in
`API/*.inc`. Each internal component gets its own file; the split into files is
purely conventional, so group by concern, not by size.

```text
SomePlugin/API/
    General.inc
    Weapons.inc
    Stats.inc
```

## One registration function per file

Each `API/*.inc` file registers its own natives in one function. That function
wraps the `register_native` calls for the component, and the main `.sma` calls
it from `plugin_natives()`:

```pawn
// SomePlugin/API/General.inc

API_General_Register() {
    register_native("SomePlugin_Announce", "@SomePlugin_Announce");
    register_native("SomePlugin_IsEnabled", "@SomePlugin_IsEnabled");
}
```

```pawn
// SomePlugin.sma

#include "SomePlugin/API/General"

public plugin_natives() {
    API_General_Register();
}
```

Native handlers follow `amxx-pawn-style` (`@` + the native's name). Keeping the
registration and the native declarations for a component in one file means a
single grep finds both ends.

## A shared registrar

When there are many `API/*.inc` files, move the calls into a separate
`Registrar.inc` with a single entry function such as `API_RegisterAll()`. The
`.sma` then calls one function instead of one per file:

```pawn
// SomePlugin/API/Registrar.inc

#include "SomePlugin/API/General"
#include "SomePlugin/API/Weapons"
#include "SomePlugin/API/Stats"

API_RegisterAll() {
    API_General_Register();
    API_Weapons_Register();
    API_Stats_Register();
}
```

```pawn
// SomePlugin.sma

#include "SomePlugin/API/Registrar"

public plugin_natives() {
    API_RegisterAll();
}
```

The registrar only aggregates; each component file still owns its own
registration.

## Gotchas

- **The `.sma` is the single caller.** Whether or not a registrar exists,
  `plugin_natives()` runs in the `.sma`; component files never register
  themselves.
- **One registration function per file.** Splitting registration across two
  functions in the same file makes the file's surface harder to trace; keep one.
- **The registrar is optional.** Add it only when the number of `API/*.inc`
  files makes a per-file list in the `.sma` noisy.

## Checklist

- [ ] All natives are declared in `API/*.inc`.
- [ ] Each API file registers its natives in exactly one function.
- [ ] The `.sma` calls each registration function from `plugin_natives()`.
- [ ] A `Registrar.inc` (`API_RegisterAll()`) exists once there are many files.
