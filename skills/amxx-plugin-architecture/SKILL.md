---
name: amxx-plugin-architecture
description: >-
  Optional architecture patterns for AMXX Pawn (AMX Mod X) plugins split across
  several files (a main .sma plus `.inc` files). Optional, for large multi-file
  plugins; each pattern applies independently. Covers include layout with
  self-sufficient includes, an API layer, thin DefaultObjects in registries,
  an entity store with handler tags and a Trie index, idempotent init, the
  _OnInited / _Init / PluginInit contract, forward subscription through the
  `.sma`, one-forward instead of callfunc, and where state lives. Includes a
  review-ready definition of done. Triggers: AMXX, AMX Mod X, Pawn, plugin
  architecture, modular plugin, multi-file plugin, plugin layout, .sma, .inc,
  registry, register_native, natives, forward, object store, DefaultObjects,
  State.inc, callfunc, CreateOneForward, include graph, definition of done. Do
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
Brace placement follows it too: every function and control-flow body keeps its
opening brace on the same line as the signature or statement (`Func() {`), never
on a line of its own. A few names are fixed by this skill instead and are
reserved, like AMXX callbacks: the framework functions
(`API_<Component>_Register`, `API_RegisterAll`,
`DefaultObjects_<Type>_<Name>_Register`, `<Type>_Init`) and the
`<File>_On<Event>` delegates the `.sma` dispatches to.

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
   their own file, and that file owns its registration, handlers, and state.
3. **A single registration point.** The `.sma` (or a registrar it includes)
   calls each file's registration function, so no file monopolizes a shared
   engine forward. The DefaultObject registrar is also the wiring point for
   registry-registration forwards and framework/event-bus subscriptions.
4. **Uniformity over shortcuts.** Objects the plugin registers into its own
   registry go through the same public natives an external plugin would call,
   not internal shortcuts.
5. **Encapsulation through functions.** The entity store's `Array` / `Trie` is
   `static` to its file; every other file reaches entities through functions.
   Other `Array` / `Trie` uses are outside this pattern.
6. **Idempotent initialization.** Every init function is safe to call twice; its
   guard is a function-local `static bool:isInited`.
7. **Explicit wiring.** A component initializes the external APIs it depends on
   even if something else already did, so restructuring never breaks the setup.
8. **Self-sufficient files.** Every `.inc` includes what it uses; no file
   depends on the `.sma` include order.
9. **State lives with its owner.** Declarations stay in the file that owns and
   uses them; do not collect them in a central `State.inc`. Extracting globals
   into a shared `State.inc` / `Globals.inc` is an antipattern, not a layout
   choice: it destroys cohesion by separating each variable from the code that
   reads and writes it, and it turns one file into a hub the whole plugin
   depends on.

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
| 9 | Explicit includes / include graph | `references/module-layout.md` | Authoring a `.inc`, or fixing a dependency that only works in one include order |
| 10 | Where state lives | `references/module-layout.md` | Deciding which file owns a variable, a constant, or a boot-status flag |

## Must do

- Treat every pattern as optional; adopt it only when the plugin is large enough
  to pay for the extra files and indirection.
- Give each includable `.sma` its own uniquely named include folder.
- Make every `.inc` self-sufficient: a unique include guard plus explicit
  includes for every header it uses.
- Keep state declarations in the file that owns them; do not create a central
  `State.inc`.
- Move all `.sma` initialization into an idempotent `PluginInit()` when the
  plugin has API functionality that needs preliminary setup.
- Register `_OnInited` and provide a synchronous `_Init` native when the plugin
  has an API-accessible registry.
- Write the init guard as a function-local `static bool:isInited`; if readiness
  must be observable, set a separate status variable at the end of init.
- Keep the entity store's `Array` / `Trie` `static` and route entity access
  through functions; other `Array` / `Trie` uses are out of scope.
- Keep DefaultObjects thin: registration, handlers, and object-local helpers;
  config parsing, lookup/default tables, and validation live in Core.
- Initialize a component's external dependencies inside its own `_Init`.
- Route engine multi-forward subscriptions through the `.sma`, one public
  handler per forward; let the DefaultObject registrar own registry-registration
  forwards and framework/event-bus subscriptions.
- Resolve a repeatedly-fired registered callback once with `CreateOneForward`
  and invoke it with `ExecuteForward`; reserve `callfunc` for ad-hoc/dynamic
  calls.
- Keep handler strings exact: `@` is part of the name for string-resolved
  handlers; AMXX/engine callbacks and declared `forward`s use `public Name`.
- Link naming and tag decisions to `amxx-pawn-style` instead of restating them.

## Must not do

- Do not apply these patterns to a small single-file plugin.
- Do not let two includable `.sma` files share a folder name.
- Do not rely on the `.sma` include order to satisfy an `.inc`'s dependencies.
- Do not create a central `State.inc` / `Globals.inc`; state stays with its
  owner. A shared global dump loses cohesion: each variable is declared where it
  is used, not in a file far from every reader.
- Do not register objects into a plugin's own registry through internal calls
  when a public native exists; use the same native external plugins use.
- Do not keep the entity store's `Array` / `Trie` in the global scope or read it
  from another file directly; keep it `static` and expose functions. This applies
  to the entity store, not to every `Array` / `Trie`.
- Do not put config parsing, lookup/default tables, or validation in a
  DefaultObject file.
- Do not write an init function that breaks when called twice.
- Do not use a global variable as the idempotence guard.
- Do not let one child file register the plugin's only handler for an engine
  multi-forward; dispatch it from the `.sma`. A framework/event-bus subscription
  owned by the registrar is not an engine multi-forward.
- Do not call a registered callback through `callfunc` when a one-forward handle
  is available.
- Do not use `@` on an engine/AMXX callback or a declared `forward`; `@` is part
  of the exported name and must match the string exactly.
- Do not redefine `amxx-pawn-style` naming (prefixes, enum roles, handler names)
  here or in the plugin; link to it.
- Do not copy an object's handler tag or struct when a shared include already
  publishes it; include that file instead.

## Verification checklist

- [ ] Every `.inc` has a unique include guard and includes the headers it uses.
- [ ] Each include folder is unique and matches its `.sma` name (or the project
      wrapper convention).
- [ ] No central `State.inc`; declarations live in their owner file.
- [ ] Natives are registered by one function per `API/*.inc` file, called from
      the `.sma` (directly or through a registrar).
- [ ] `DefaultObjects/` registers one thin object per file, through the registry
      owner's forward.
- [ ] Each DefaultObject contains only registration, handlers, and object-local
      helpers; config parsing, lookup/default tables, and validation live in
      Core.
- [ ] Objects registered into the plugin's own registry use the public natives.
- [ ] The entity store's `Array:` / `Trie:` are `static`, with all access
      through functions; the handler tag and struct come from the shared include
      when one exists. Other `Array` / `Trie` uses are out of scope.
- [ ] Every init function is idempotent with a function-local `static` guard; a
      separate status variable is set at the end of init if readiness is
      exposed.
- [ ] A plugin with an API registry exposes `_OnInited` and `_Init`, and funnels
      setup through `PluginInit()`.
- [ ] Engine multi-forward subscriptions flow through the `.sma`; registry-
      registration forwards and framework/event-bus subscriptions may live in
      the registrar.
- [ ] Repeated registered callbacks use `CreateOneForward` + `ExecuteForward`,
      with `DestroyForward` on re-registration.
- [ ] Handler strings match declarations exactly, including `@`; AMXX/engine
      callbacks and declared `forward`s use bare `public Name`.

## Definition of done (review-ready multi-file plugin)

Run this sequence before review. Each step is a gate.

1. **Includes.** Every `.inc` has a unique guard and includes what it uses; no
   include cycles; the `.sma` include order is irrelevant.
2. **Layout.** One include folder per `.sma`; `API/`, `DefaultObjects/`, and
   `Objects/` follow the layout.
3. **State.** No central `State.inc`; declarations live in their owner file;
   the entity store's `Array` / `Trie` are `static` with function access; a boot
   status, if exposed, is a separate variable set at the end of init.
4. **API.** Natives live in `API/*.inc`; one registration function per file;
   `plugin_natives()` calls it directly or through `API_RegisterAll()`.
5. **DefaultObjects.** One thin object per file; the registrar includes every
   object; the `.sma` includes only the registrar; registration goes through the
   registry owner's forward; self-registration uses public natives.
6. **Init.** Every init is idempotent with a function-local `static` guard; a
   component initializes its own prerequisites; `_OnInited` / `_Init` /
   `PluginInit()` are wired when an API registry exists; `_OnInited` fires once.
7. **Forwards.** Engine multi-forwards are in the `.sma`; registered hooks may
   live in `_Init`; registry/framework subscriptions live in the registrar;
   repeated callbacks use one-forward, not `callfunc`; `DestroyForward` on
   re-registration.
8. **Names and strings.** `@` only on handlers resolved by an exact string;
   AMXX/engine callbacks and declared `forward`s are `public Name`; every string
   matches the declaration exactly; `CreateOneForward`'s `-1` is checked.

## Not yet covered (extend here)

This is the initial set of patterns; more will be added over time. Extend this
skill by adding a reference file and a matching row to the patterns table.
Areas not specified yet, and candidates for a future reference: command routing
across modules, configuration loading per component, and per-module test or
debug hooks. Include conventions (guards, ordering, self-sufficient files) are
owned by `amxx-pawn-style`; link to that skill instead of restating them. Keep
new patterns optional and independently applicable, and link naming questions
to `amxx-pawn-style`.
