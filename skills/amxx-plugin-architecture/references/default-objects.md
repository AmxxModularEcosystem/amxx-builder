# DefaultObjects (objects registered into registries)

How a plugin describes the objects it registers into registries, whether the
registry belongs to another plugin or to the plugin itself.

## Contents

- [One object per file](#one-object-per-file)
- [The registry registrar](#the-registry-registrar)
- [Self-registration in the plugin's own registry](#self-registration-in-the-plugins-own-registry)
- [Gotchas](#gotchas)
- [Checklist](#checklist)

## One object per file

When the plugin registers entities into a registry (its own or another
plugin's), each object is described in
`SomePlugin/DefaultObjects/<object type>/<object name>.inc`.

The file exposes one function,
`DefaultObjects_<object type>_<object name>_Register()`. That function registers
the object in the registry and, when the object needs them, the required hooks.
All handlers for the object live in the same file:

```pawn
// SomePlugin/DefaultObjects/Weapons/Ak47.inc

DefaultObjects_Weapons_Ak47_Register() {
    // register the object through the registry owner's public native
    SomeRegistry_RegisterWeapon("weapon_ak47", "@OnAk47PickedUp");

    // this object's handlers live in this same file
}

@OnAk47PickedUp(const playerIndex) {
    // object handler
}
```

Keep one object per file. When several objects are essentially variants of the
same thing, they may share one file, but that is the exception, not the default.

## The registry registrar

`SomePlugin/DefaultObjects/Registrar.inc` includes every entity and declares,
for each object type, the public forward the registry-owner plugin requires for
registration. The `.sma` only includes the registrar:

```pawn
// SomePlugin/DefaultObjects/Registrar.inc

#include "SomePlugin/DefaultObjects/Weapons/Ak47"
#include "SomePlugin/DefaultObjects/Weapons/M4A1"
#include "SomePlugin/DefaultObjects/Items/Medkit"

// One public forward per object type, fired by the registry owner.
public Weapons_OnRegistryOpen() {
    DefaultObjects_Weapons_Ak47_Register();
    DefaultObjects_Weapons_M4A1_Register();
}

public Items_OnRegistryOpen() {
    DefaultObjects_Items_Medkit_Register();
}
```

```pawn
// SomePlugin.sma

// The registrar declares the registration forwards; the .sma only includes it.
#include "SomePlugin/DefaultObjects/Registrar"
```

The forward the registry owner fires is the sanctioned place to register objects
into that registry. The registrar declares those forwards itself, so the `.sma`
calls nothing to trigger registration and only includes the registrar; general
multi-forwards still route through the `.sma`, which owns the single public
handler, and registry-registration forwards are the one exception.

## Self-registration in the plugin's own registry

If the plugin has its own public registry (open to object registration through
its API) and also registers some objects into it itself, those objects are
described the same way under `DefaultObjects`. The registration function calls
the **same public natives** an external plugin would call, not internal
shortcuts:

```pawn
// SomePlugin/DefaultObjects/Weapons/Ak47.inc

DefaultObjects_Weapons_Ak47_Register() {
    // the SAME public native any external plugin would call
    SomePlugin_RegisterWeapon("weapon_ak47", "@OnAk47PickedUp");
}
```

This keeps every registration, internal or external, on one path: the API is
exercised uniformly, so a bug in the public native surfaces in the plugin's own
objects too.

## Gotchas

- **Registration goes through the registry owner's forward.** Do not register
  objects from `plugin_init` or from a general forward unless the registry owner
  documents that forward for registration.
- **Self-registration is not special.** It uses the public native; an internal
  call would bypass the API and hide the bugs the public path catches.
- **One type, one forward.** A registrar declares one public forward per object
  type, and each forward calls that type's objects' `_Register()` functions.

## Checklist

- [ ] Each object has its own `DefaultObjects/<type>/<name>.inc` and a
      `DefaultObjects_<type>_<name>_Register()` function.
- [ ] All handlers for an object live in that object's file.
- [ ] `DefaultObjects/Registrar.inc` includes every object and declares one
      registration forward per type.
- [ ] Each object type registers in the forward the registry owner requires.
- [ ] The `.sma` only includes the registrar; it calls nothing to trigger
      registration.
- [ ] Self-registered objects call the plugin's public natives, not internal
      functions.
