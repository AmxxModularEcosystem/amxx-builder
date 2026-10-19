# Initialization

Two requirements that keep a multi-file plugin's setup predictable: every init
is idempotent, and a plugin with an API exposes a readiness contract.

## Contents

- [Idempotent initialization](#idempotent-initialization)
- [The plugin init contract](#the-plugin-init-contract)
- [Gotchas](#gotchas)
- [Checklist](#checklist)

## Idempotent initialization

All initializations MUST be idempotent, both the plugin itself and each of its
components. Calling an init twice must be safe and must not leak memory or
double-initialize a structure.

The guard is always a function-local static variable:

```pawn
SomeObject_Init() {
    static bool:isInited = false;
    if (isInited) {
        return;
    }
    isInited = true;

    // ... one-time setup ...
}
```

The static lives in the function, so each component owns its own guard without
adding a global. Do not use a file-scope or global variable as the guard, and
never read the guard from another file. If other code needs to know whether the
component is ready, declare a separate status variable in the owner file and set
it at the end of a successful init; that variable is not the guard and must not
short-circuit init. Naming and shape of that status variable are not prescribed
here.

## The plugin init contract

If the plugin has an API-accessible entity registry, or any API functionality
that needs preliminary initialization, it MUST:

- register a global multi-forward of the form `_OnInited`, called once after the
  plugin is initialized, regardless of whether individual components also have
  similar forwards;
- provide a native of the form `_Init` that forcibly and synchronously
  initializes the plugin.

To support both, move all initialization in the `.sma` into one function of the
form `PluginInit()`, called either through the API or in `plugin_precache`,
whichever comes first:

```pawn
// SomePlugin.sma

public plugin_precache() {
    PluginInit();
}

PluginInit() {
    static bool:isInited = false;
    if (isInited) {
        return;
    }
    isInited = true;

    // initialize the plugin's components ...
    API_Init();

    // announce readiness to the rest of the world
    SomePlugin_OnInited();
}
```

The `_Init` native calls the same `PluginInit()`, so a consumer that needs the
plugin ready can force it synchronously:

```pawn
// SomePlugin/API/Init.inc

API_Init_Register() {
    register_native("SomePlugin_Init", "@SomePlugin_Init");
}

@SomePlugin_Init() {
    PluginInit();
    return 1;
}
```

The `_OnInited` forward is declared where consumers can see it (the shared
`.inc`) and is signaled once, from `PluginInit()`:

```pawn
/**
 * Called once after the plugin has finished initializing.
 */
forward SomePlugin_OnInited();
```

Because `PluginInit()` is idempotent, whichever path arrives first (a direct
`_Init` call or `plugin_precache`) wins and the other becomes a no-op. The
forward fires exactly once either way.

## Gotchas

- **`_OnInited` is signaled once.** It fires from inside the idempotent
  `PluginInit()`, so a second init path does not signal it again.
- **`_Init` is synchronous.** It forces full initialization before returning;
  it does not schedule the work.
- **The contract is not just for registries.** Any API feature that needs
  preliminary setup is covered, registry or not.
- **`plugin_precache` is a call site, not the contract.** It is one of two
  entry points into `PluginInit()`; the other is the `_Init` native.
- **The guard is not a public status flag.** Do not export it or read it from
  another file. A separate readiness variable is set at the end of a successful
  init and never replaces the guard.

## Checklist

- [ ] Every init function is idempotent, with a function-local
      `static bool:isInited = false` guard.
- [ ] No file-scope/global variable is used as the guard, and no other file
      reads the guard.
- [ ] If readiness is exposed, it is a separate variable set at the end of
      successful init, not the guard.
- [ ] A plugin with an API registry registers `_OnInited` and provides `_Init`.
- [ ] All `.sma` initialization lives in `PluginInit()`.
- [ ] `PluginInit()` is called from `plugin_precache` or through the `_Init`
      native.
- [ ] `_OnInited` is signaled once, from `PluginInit()`.
