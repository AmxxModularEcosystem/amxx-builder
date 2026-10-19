# Subscribing to forwards through the `.sma`

How child `.inc` files reach a multi-forward that only one public function per
plugin can handle.

## Contents

- [Subscribing to forwards through the `.sma`](#subscribing-to-forwards-through-the-sma)
  - [Contents](#contents)
  - [One handler per forward](#one-handler-per-forward)
  - [Delegating to child files](#delegating-to-child-files)
  - [Hooks registered inside `_Init`](#hooks-registered-inside-_init)
  - [Calling a registered callback: one-forward, not callfunc](#calling-a-registered-callback-one-forward-not-callfunc)
  - [The registrar exception](#the-registrar-exception)
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

## Calling a registered callback: one-forward, not callfunc

A callback registered once and fired many times is a forward handle, not a
`callfunc` target. Resolve it once with `CreateOneForward(pluginId, name, ...)`,
store the handle, and invoke it with `ExecuteForward`. This avoids a name lookup
per event, validates the parameter list against the declared `FP_*` types, and
gives the subscription an explicit lifecycle.

```pawn
new KillForward = -1;

SubscribeKill(const pluginId) {
    KillForward = CreateOneForward(pluginId, "@OnKill", FP_CELL);
    if (KillForward == -1) {
        // the handler name did not resolve; fix the string or the declaration
        return;
    }
}

@OnKill(const playerIndex) {
    // ...
}

ExecuteKillCallback(const playerIndex) {
    new result;
    ExecuteForward(KillForward, result, playerIndex);
}

UnsubscribeKill() {
    if (KillForward != -1) {
        DestroyForward(KillForward);
        KillForward = -1;
    }
}
```

`CreateOneForward` does not deduplicate: each call creates a handle. Store it,
and call `DestroyForward` when the subscription is replaced or removed.

Use `callfunc` only for ad-hoc/dynamic calls where the signature is not fixed
or no persistent handle is wanted. If a name must be called repeatedly, cache
`get_func_id` and use `callfunc_begin_i` rather than resolving the string each
time.

Name matching is exact. Because `@` is part of the exported name, a handler
declared `@OnKill` must be passed as `"@OnKill"`. A bare `"OnKill"` compiles but
`CreateOneForward` returns `-1`, and `ExecuteForward(-1)` silently returns `0`.

## The registrar exception

The exception is the DefaultObject registrar. It declares the registry-
registration forwards: one public forward per object type, each calling its
objects' `_Register()` functions. The `.sma` does not trigger them; it only
includes the registrar.

The registrar may also own framework/event-bus subscription handlers. Those are
string-resolved callbacks, not engine multi-forwards; the `.sma` still owns
every engine multi-forward. If some other code needs a registry-registration
forward, the same `.sma` delegation scheme applies, but that is rare.

## Gotchas

- **Only one public handler per forward.** Two child files declaring
  `client_putinserver` is a compile error, not a merge.
- **Delegates are ordinary functions.** The child's
  `SomeObject_OnClientPutInServer` is plain, not `public`; the `.sma` owns the
  public entry point.
- **Hooks differ from forwards.** `RegisterHam` / `RegisterHookChain` handlers
  can be registered from a component's `_Init`; multi-forwards cannot.
- **Registrar forwards and framework subscriptions are the exception.**
  Registry-registration forwards and framework/event-bus subscription handlers
  live in the DefaultObject registrar, not in the general `.sma` delegation.
  Engine multi-forwards still go through the `.sma`.
- **Name matching is exact.** `@` is part of the exported name; a handler
  declared `@OnKill` must be passed as `"@OnKill"`. A bare name resolves to `-1`
  in `CreateOneForward`, and `ExecuteForward(-1)` silently returns `0`.
- **`callfunc` is untyped.** A one-forward checks the parameter count against the
  types declared at creation; `callfunc` checks nothing.

## Checklist

- [ ] Each multi-forward has exactly one public handler, in the `.sma`.
- [ ] Child files expose ordinary functions the `.sma` handler calls.
- [ ] `RegisterHam` / `RegisterHookChain` hooks may register in `_Init`.
- [ ] Registry-registration forwards and framework/event-bus subscriptions may
      live in the registrar; engine multi-forwards stay in the `.sma`.
- [ ] Repeated registered callbacks use `CreateOneForward` + `ExecuteForward`,
      with `DestroyForward` on re-registration.
- [ ] Handler names passed as strings match the declaration exactly, including
      `@`.
- [ ] `callfunc` is reserved for ad-hoc/dynamic calls with no persistent handle.
