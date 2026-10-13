# Module layout for multi-file plugins

Where the includable files of a multi-file plugin live, and how they are
referenced.

## Contents

- [One include folder per `.sma`](#one-include-folder-per-sma)
- [Wrapping several plugins in a project folder](#wrapping-several-plugins-in-a-project-folder)
- [Layout example](#layout-example)
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

## Gotchas

- **The folder is not inside the `.sma`.** The folder sits next to
  `SomePlugin.sma` and holds its includes; the include path starts with the
  folder name (`SomePlugin/API/General`).
- **One folder per `.sma`, not per project.** Two plugins in the same project do
  not share an include folder even when they appear related.
- **The project wrapper changes nothing about compilation.** It groups the
  plugins for humans; each `.sma` and its include folder stay self-contained.

## Checklist

- [ ] Every `.sma` that includes other files has its own include folder.
- [ ] The include folder name is unique and, by convention, matches the `.sma`.
- [ ] Every `#include` path starts with the folder name.
- [ ] Several plugins in one project sit inside a project wrapper folder.
