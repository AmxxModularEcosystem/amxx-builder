# Subscribing to forwards through the `.sma`

How child `.inc` files reach a multi-forward that only one public function per
plugin can handle.

## Contents

- [Subscribing to forwards through the `.sma`](#subscribing-to-forwards-through-the-sma)
  - [Contents](#contents)
  - [One handler per forward](#one-handler-per-forward)
  - [Delegating to child files](#delegating-to-child-files)
  - [Hooks registered inside `_Init`](#hooks-registered-inside-_init)
  - [The registry-registration exception](#the-registry-registration-exception)
  - [Gotchas](#gotchas)
  - [Checklist](#checklist)

## One handler per forward

A plugin can have only one handler (public function) for each multi-forward such
as `client_putinserver`. If several child `.inc` files each want to react to it,
they cannot each declare that public function.

Resolve this by letting the child files expose ordinary functions and having the
`.sma` own the single public handler that calls them.

## Delegating to child files

A child file declares a function such as
`SomeObject_OnClientPutInServer(const playerIndex)`. The `.sma`'s public
`client_putinserver` calls it:

```pawn
// SomePlugin/Objects/SomeObject.inc

SomeObject_OnClientPutInServer(const playerIndex) {
    // react to the connection ...
}
```

```pawn
// SomePlugin.sma

#include "SomePlugin/Objects/SomeObject"

public client_putinserver(playerIndex) {
    SomeObject_OnClientPutInServer(playerIndex);
}
```

With several subscribers, the `.sma` handler calls each one in order:

```pawn
public client_putinserver(playerIndex) {
    SomeObject_OnClientPutInServer(playerIndex);
    SomeOther_OnClientPutInServer(playerIndex);
}
```

This keeps the forward from becoming the property of a single file: the `.sma`
is the one place that decides who subscribes and in what order.

## Hooks registered inside `_Init`

Forward subscriptions route through the `.sma`, but registered hooks such as
`RegisterHam` or `RegisterHookChain` MAY be registered in a component's `_Init`
function inside the file:

```pawn
SomeObject_Init() {
    static bool:isInited = false;
    if (isInited) {
        return;
    }
    isInited = true;

    RegisterHam(Ham_Spawn, "player", "@SomeObject_OnPlayerSpawn", true);
}
```

The distinction: a multi-forward has a fixed public entry point the engine calls
by name, so it needs the `.sma`; a registered hook is dispatched through the
handler the file hands to `RegisterHam` / `RegisterHookChain`, so the file can
own it.

## The registry-registration exception

The one exception is the forwards used to register objects into registries.
Those live in the DefaultObject registrar, which declares one public forward per
object type, each calling its objects' `_Register()` functions; the `.sma` does
not trigger them, it only includes the registrar. If some other code needs such
a forward, the same `.sma` delegation scheme applies, but that is rare.

## Gotchas

- **Only one public handler per forward.** Two child files declaring
  `client_putinserver` is a compile error, not a merge.
- **Delegates are ordinary functions.** The child's
  `SomeObject_OnClientPutInServer` is plain, not `public`; the `.sma` owns the
  public entry point.
- **Hooks differ from forwards.** `RegisterHam` / `RegisterHookChain` handlers
  can be registered from a component's `_Init`; multi-forwards cannot.
- **Registry forwards are the exception.** They live in the DefaultObject
  registrars, not in the general `.sma` delegation.

## Checklist

- [ ] Each multi-forward has exactly one public handler, in the `.sma`.
- [ ] Child files expose ordinary functions the `.sma` handler calls.
- [ ] `RegisterHam` / `RegisterHookChain` hooks may register in `_Init`.
- [ ] Registry-registration forwards stay in the DefaultObject registrars.
