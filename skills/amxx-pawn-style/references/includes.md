# Includes in AMXX Pawn

How a `.inc` declares its dependencies so it compiles in any include order,
alone or as part of a larger plugin.

## Contents

- [Include guard](#include-guard)
- [Include what you use](#include-what-you-use)
- [Where dependencies come from](#where-dependencies-come-from)
- [Recommended order](#recommended-order)
- [Breaking include cycles](#breaking-include-cycles)
- [Gotchas](#gotchas)
- [Checklist](#checklist)

## Include guard

Every `.inc` starts with a unique guard. The guard makes the file safe to
include more than once and lets a consumer include it without tracking what was
already included:

```pawn
#if defined _SomePlugin_API_General_included
    #endinput
#endif
#define _SomePlugin_API_General_included
```

Derive the guard name from the full path, not just the basename. Two files named
`General.inc` in different folders with the same guard would make the second
file silently disappear.

The `.sma` itself needs no guard: nothing includes it.

## Include what you use

A file includes every header whose symbols it uses, immediately after the
guard. Do not rely on the `.sma` or another `.inc` having included a dependency
first; a file that only compiles after some other file was included is not
self-sufficient.

- Include project-local files with `"..."`: `#include "SomePlugin/Core/EventModel"`.
- Include AMXX, module, and third-party public headers with `<...>`:
  `#include <amxmodx>`, `#include <engine>`, `#include <fakemeta>`.
- Include a file because the file uses it, not because the plugin as a whole
  uses it. A file that only declares plain constants does not need
  `<amxmodx>`; a file that calls AMXX natives does.
- Include the shared model that declares a type, not the file that happens to
  include that model. This keeps the dependency graph acyclic.

## Where dependencies come from

| Dependency | Form | Example |
|---|---|---|
| AMXX core natives, constants, forwards | `<...>` | `#include <amxmodx>` |
| A module (`engine`, `fakemeta`, `hamsandwich`, …) | `<...>` | `#include <engine>` |
| A third-party dependency on the compiler include path | `<...>` | `#include <ParamsController>` |
| A project-local file under the plugin folder | `"..."` | `#include "SomePlugin/API/General"` |
| A shared model used by several folders | `"..."` | `#include "SomePlugin/Core/EventModel"` |

The local path starts with the plugin's include folder, so the include root does
not need to change per file.

## Recommended order

1. The include guard.
2. `<amxmodx>` when the file uses AMXX core.
3. Other `<...>` headers, alphabetical within the group.
4. Project shared models with `"..."`.
5. Local sibling files with `"..."`.

Put `<amxmodx>` before the other groups because some module headers and pragmas
expect the core to be available. The order inside groups is a readability
convention, not a correctness requirement: self-sufficient files compile in any
order a consumer chooses.

## Breaking include cycles

When two files need the same type, struct, constant, or forward declaration,
move that shared model into a third file and have both include it:

```pawn
// SomePlugin/Core/EventModel.inc
#if defined _SomePlugin_Core_EventModel_included
    #endinput
#endif
#define _SomePlugin_Core_EventModel_included

enum _:S_Event
{
    Event_Name[32],
    Event_Value
}
```

```pawn
// SomePlugin/Objects/EventQueue.inc
#include "SomePlugin/Core/EventModel"

// SomePlugin/DefaultObjects/Events/Handler.inc
#include "SomePlugin/Core/EventModel"
```

Neither file includes the other. The shared model is the bottom of the graph: it
includes only the standard library and other model files, never the files that
include it.

Do not use a central state file as a cycle-breaker. State declarations belong to
the file that owns them; a shared model holds types and constants, not mutable
state.

## Gotchas

- **A file that needs a prior include is not self-sufficient.** If it compiles
  only after the `.sma` included something first, add the missing include to the
  file itself.
- **A guard collision silently skips a file.** Two files with the same
  `_..._included` macro compile as one; derive the guard from the full path.
- **Repeated `<amxmodx>` is safe.** The AMXX headers are guarded, so later
  includes hit `#endinput`; there are no duplicate symbols. The cost after the
  first include is one preprocessor check.
- **Pragmas and defines come before the include they affect.** Define
  `AMXMODX_NOAUTOLOAD` (or a similar switch) before `<amxmodx>`; a
  self-sufficient `.inc` cannot assume the consumer did.
- **`#tryinclude` is for optional dependencies.** Guard the symbols the optional
  file provides, so a missing include does not break the file.

## Checklist

- [ ] Every `.inc` starts with a unique include guard; the `.sma` has none.
- [ ] Every `.inc` includes every header whose symbols it uses.
- [ ] Local files use `"..."` with the plugin folder path; AMXX, module, and
  third-party headers use `<...>`.
- [ ] No file depends on the `.sma` or another `.inc` having included a header
  first.
- [ ] Shared types and constants live in a shared model `.inc`, not in a mutual
  include and not in a central state file.
- [ ] Include cycles are broken by a third file, not by two files including each
  other.
- [ ] Optional `#tryinclude` dependencies have their symbols guarded.
