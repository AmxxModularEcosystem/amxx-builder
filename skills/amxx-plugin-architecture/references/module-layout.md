# Module layout for multi-file plugins

Where the includable files of a multi-file plugin live, and how they are
referenced.

## Contents

- [One include folder per `.sma`](#one-include-folder-per-sma)
- [Wrapping several plugins in a project folder](#wrapping-several-plugins-in-a-project-folder)
- [Layout example](#layout-example)
- [Explicit includes](#explicit-includes)
- [Where state lives](#where-state-lives)
- [Gotchas](#gotchas)
- [Checklist](#checklist)

## One include folder per `.sma`

When a plugin is split into several files (a main `.sma` plus included `.inc`
files), every includable file goes into one separate folder per `.sma` file.

There are no strict requirements on the folder name except that it must be
unique among the plugin's folders. The conventional choice is the `.sma`
filename: `SomePlugin.sma` keeps its includes in `SomePlugin/`.

The include path is relative to the include root, and the folder name leads it:

```pawn
#include "SomePlugin/API/General"
#include "SomePlugin/Objects/SomeObject"
```

Keep the folder unique because two plugins with the same folder name would
collide on the include path. The `.sma` filename is unique per plugin, so it
makes a safe default.

## Wrapping several plugins in a project folder

If the project holds several such plugins, wrap them in one folder named after
the project. Each plugin keeps its own `.sma` and its own include folder inside
that wrapper:

```text
SomeProject/
    SomePlugin.sma
    SomePlugin/
        API/
        DefaultObjects/
        Objects/
    OtherPlugin.sma
    OtherPlugin/
        API/
        Objects/
```

The wrapper is for organization only; each plugin is still a standalone `.sma`
with its own include folder.

## Layout example

A single multi-file plugin with every pattern folder in place:

```text
SomePlugin.sma
SomePlugin/
    API/
        General.inc
        Registrar.inc
    DefaultObjects/
        Registrar.inc
        Weapons/
            Ak47.inc
        Items/
            Medkit.inc
    Objects/
        SomeObject.inc
```

The main `.sma` includes the pieces:

```pawn
// SomePlugin.sma

#include "SomePlugin/API/General"
#include "SomePlugin/DefaultObjects/Registrar"
#include "SomePlugin/Objects/SomeObject"
```

## Explicit includes

Every `.inc` is self-sufficient: it starts with a unique include guard and
includes every header it uses, both `<...>` (AMXX/module/third-party) and
`"..."` (project-local). Do not rely on the `.sma` or another `.inc` having
included a dependency first.

The full include conventions (guard naming, ordering, `<...>` vs `"..."`,
cycle breaking) are part of the style skill. This section fixes the layout
consequence: a local include path starts with the plugin folder
(`SomePlugin/API/General`), and a shared model file such as
`Core/EventModel.inc` is the place for types that two folders both need.

```pawn
// SomePlugin/API/General.inc
#if defined _SomePlugin_API_General_included
    #endinput
#endif
#define _SomePlugin_API_General_included

#include <amxmodx>
#include "SomePlugin/Core/EventModel"
```

## Where state lives

Declare variables and constants in the file that owns them: config in
`Core/Config.inc`, registry state in `Objects/Registry.inc`, forwards in
`Core/Forward.inc`, object defaults in the object's own file. Do not create a
central `State.inc` or `Globals.inc` that every file includes; it hides the
owner and turns one file into a hub.

For the entity store, expose functions that return or mutate entities instead
of reading the `Array` / `Trie` directly (see the objects-store pattern). Other
state is not covered by that rule: a component's readiness flag, for example,
may be a separate variable set at the end of init.

The idempotence guard is always a function-local `static bool:isInited` inside
the init function (see the initialization pattern). Never read it from another
file. If other code needs the component's readiness, declare a separate status
variable in the owner file and set it at the end of a successful init; that
variable is not the guard and must not short-circuit init.

## Gotchas

- **The folder is not inside the `.sma`.** The folder sits next to
  `SomePlugin.sma` and holds its includes; the include path starts with the
  folder name (`SomePlugin/API/General`).
- **One folder per `.sma`, not per project.** Two plugins in the same project do
  not share an include folder even when they appear related.
- **The project wrapper changes nothing about compilation.** It groups the
  plugins for humans; each `.sma` and its include folder stay self-contained.
- **A central `State.inc` is not a module.** It is a hub every file depends on;
  move each declaration to its owner file.
- **A file that compiles only after another file was included first is not
  self-sufficient.** Add the missing include to the file itself.
- **Two files that include each other need a third file.** Extract the shared
  types or constants into a shared model and have both include it.

## Checklist

- [ ] Every `.sma` that includes other files has its own include folder.
- [ ] The include folder name is unique and, by convention, matches the `.sma`.
- [ ] Every `#include` path starts with the folder name.
- [ ] Several plugins in one project sit inside a project wrapper folder.
- [ ] Every `.inc` has a unique include guard and includes its own dependencies.
- [ ] No central `State.inc` / `Globals.inc`; state lives in its owner file.
- [ ] The entity store is accessed through functions, not by reading its
  `Array` / `Trie` from another file.
- [ ] The init guard is function-local; readiness, if exposed, is a separate
  status variable.
- [ ] Shared types live in a shared model `.inc`, not in a mutual include.
