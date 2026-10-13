---
name: amxx-plugin-architecture
description: >-
  Optional architecture patterns for AMXX Pawn (AMX Mod X) plugins split across
  several files (a main .sma plus included .inc files). Unlike the mandatory
  style skill amxx-pawn-style, these patterns are optional, target mostly large,
  multi-file plugins, and each pattern can be applied independently. Covers a
  per-plugin include folder layout, an API layer, DefaultObjects registered into
  registries (own or external, including self-registration), an entity object
  store with handler tags and a Trie key index, idempotent initialization, a
  plugin init contract (_OnInited / _Init / PluginInit), and subscribing to
  multi-forwards through the .sma. Triggers: AMXX, AMX Mod X, Pawn, plugin
  architecture, modular plugin, multi-file plugin, plugin layout, .sma, .inc,
  registry, register_native, natives, forward, object store, DefaultObjects. Do
  NOT use for naming and code style (use amxx-pawn-style), or for building,
  packaging, or deploying an AMXX server or project (use amxb-migration / the
  amxb CLI).
---

# AMXX plugin architecture

Optional architecture patterns for AMXX Pawn (AMX Mod X) plugins. This skill is
**optional** and sits next to the mandatory code-style skill `amxx-pawn-style`:
style applies to every plugin, these patterns apply only when a plugin is large
enough to benefit. They target mostly **large plugins** and **plugins split
across several files** (a main `.sma` plus one or more included `.inc` files).

Each pattern is independent. Adopt one, a few, or none of them: a plugin can use
the object store without the API layer, or subscribe to forwards through the
`.sma` without DefaultObjects. Read only the reference that matches the task at
hand.

The patterns describe structure and wiring, not naming. Names and tags follow
`amxx-pawn-style` (PascalCase functions, `S_` / `E_` / `T_` enum roles,
`@NativeName` handlers); this skill links to it and does not repeat those rules.
A few names are fixed by this skill instead and are reserved, like AMXX
callbacks: the framework functions (`API_<Component>_Register`,
`API_RegisterAll`, `DefaultObjects_<Type>_<Name>_Register`,
`<Type>_Init`) and the `<File>_On<Event>` delegates the `.sma` dispatches to.

## When to use

- Splitting a plugin into a main `.sma` plus `.inc` files, or laying out a new
  multi-file plugin.
- Exposing a plugin API, or organizing its natives.
- Registering objects into a registry, or building a registry of your own.
- Storing entities behind handler tags with an `Array:` / `Trie:` store.
- Writing an init function, or wiring plugin readiness (`_OnInited` / `_Init`).
- A child `.inc` needs a multi-forward the `.sma` already handles.

## When not to use

- Small single-file plugins. These patterns add files and indirection a small
  plugin does not need.
- Naming, typing, or enum-role questions: use `amxx-pawn-style`.
- Building, packaging, or deploying a server/project: use `amxb-migration` or
  the `amxb` CLI.

## Core principles

1. **Optional and composable.** Every pattern stands alone; adopting one never
   forces another. A large plugin is the target, not a requirement.
2. **One file per concern.** An API surface, an object, and a store each get
   their own file, and that file owns its registration and handlers.
3. **A single registration point.** The `.sma` (or a registrar it includes)
   calls each file's registration function, so no file monopolizes a shared
   forward.
4. **Uniformity over shortcuts.** Objects the plugin registers into its own
   registry go through the same public natives an external plugin would call,
   not internal shortcuts.
5. **Encapsulation through functions.** A store's `Array` / `Trie` is `static`
   to its file; every other file reaches entities through functions.
6. **Idempotent initialization.** Every init function is safe to call twice.
7. **Explicit wiring.** A component initializes the external APIs it depends on
   even if something else already did, so restructuring never breaks the setup.

## Patterns

Each pattern lives in one reference file. Load only the row you need.

| # | Pattern | Reference | Load when |
|---|---------|-----------|-----------|
| 1 | Module layout | `references/module-layout.md` | Splitting a plugin into a main `.sma` plus `.inc` files, or deciding where includes live |
| 2 | API layer | `references/api-layer.md` | Exposing natives, organizing `API/*.inc`, or registering natives per file |
| 3 | DefaultObjects | `references/default-objects.md` | Registering objects into a registry (its own or another plugin's) |
| 4 | Self-registration | `references/default-objects.md` | The plugin also registers objects into its own public registry |
| 5 | Objects store | `references/objects-store.md` | Storing entities behind handler tags with `Array:` / `Trie:` |
| 6 | Idempotent init | `references/initialization.md` | Writing any init function (`_Init`, `PluginInit`) |
| 7 | Plugin init contract | `references/initialization.md` | Exposing an API registry, or wiring `_OnInited` / `_Init` / `PluginInit` |
| 8 | Forward subscription | `references/forward-subscriptions.md` | A child `.inc` needs a multi-forward, or the `.sma` dispatches a callback |

## Must do

- Treat every pattern as optional; adopt it only when the plugin is large enough
  to pay for the extra files and indirection.
- Give each includable `.sma` its own uniquely named include folder.
- Move all `.sma` initialization into an idempotent `PluginInit()` when the
  plugin has API functionality that needs preliminary setup.
- Register `_OnInited` and provide a synchronous `_Init` native when the plugin
  has an API-accessible registry.
- Keep store handles `static` in their file and route all entity access through
  functions.
- Initialize a component's external dependencies inside its own `_Init`.
- Route multi-forward subscriptions through the `.sma`, one public handler per
  forward.
- Link naming and tag decisions to `amxx-pawn-style` instead of restating them.

## Must not do

- Do not apply these patterns to a small single-file plugin.
- Do not let two includable `.sma` files share a folder name.
- Do not register objects into a plugin's own registry through internal calls
  when a public native exists; use the same native external plugins use.
- Do not keep a store's `Array` / `Trie` in the global scope or read it from
  another file directly; keep it `static` and expose functions.
- Do not write an init function that breaks when called twice.
- Do not let one child file register the plugin's only handler for a shared
  multi-forward; dispatch it from the `.sma`.
- Do not redefine `amxx-pawn-style` naming (prefixes, enum roles, handler names)
  here or in the plugin; link to it.
- Do not copy an object's handler tag or struct when a shared include already
  publishes it; include that file instead.

## Verification checklist

- [ ] Each include folder is unique and matches its `.sma` name (or the project
      wrapper convention).
- [ ] Natives are registered by one function per `API/*.inc` file, called from
      the `.sma` (directly or through a registrar).
- [ ] `DefaultObjects/` registers one object per file, through the registry
      owner's forward.
- [ ] Objects registered into the plugin's own registry use the public natives.
- [ ] A store's `Array:` / `Trie:` are `static`, with all access through
      functions; the handler tag and struct come from the shared include when
      one exists.
- [ ] Every init function is idempotent.
- [ ] A plugin with an API registry exposes `_OnInited` and `_Init`, and funnels
      setup through `PluginInit()`.
- [ ] Multi-forward subscriptions flow through the `.sma`, not a child file.

## Not yet covered (extend here)

This is the initial set of patterns; more will be added over time. Extend this
skill by adding a reference file and a matching row to the patterns table.
Areas not specified yet, and candidates for a future reference: include ordering
within a file, command routing across modules, configuration loading per
component, and per-module test or debug hooks. Keep new patterns optional and
independently applicable, and link naming questions to `amxx-pawn-style`.
