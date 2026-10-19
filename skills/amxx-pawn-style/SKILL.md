---
name: amxx-pawn-style
description: >-
  Coding conventions for AMXX Pawn (AMX Mod X / GoldSrc .sma and .inc) without
  Hungarian notation. Use when writing, editing, refactoring, or reviewing Pawn
  code — variables, constants, enums, natives, metadata, includes, or comments.
  Enforces PascalCase functions, CamelCase globals, camelCase locals,
  `playerIndex`, `const` parameters, `MAX_PLAYERS + 1` arrays, `bool:` tags,
  sparse comments, K&R braces, and self-sufficient guarded `.inc` files. Rarer constructs
  live in references: enum roles (S_, E_, T_) with `Invalid_*`, `@` handlers
  resolved by exact string, and `PluginName` metadata. Triggers: AMXX, AMX Mod X,
  Pawn, .sma, .inc, naming convention, native, register_native, plugin metadata,
  type tag, enum, plugin_end, Hungarian notation, comment, include guard,
  #include, string-registered handler, `@` handler, венгерская нотация, стиль
  кода. Do NOT use for building/packaging/deploying servers (use amxb-migration /
  the amxb CLI), or for non-Pawn languages.
---

# AMXX Pawn code style

Canonical naming and typing conventions for AMXX Pawn (AMX Mod X) code. The
governing goal is to **remove Hungarian notation**: never encode a value's type
or scope in its identifier. Pawn already has real type tags (`Float:`,
`bool:`, custom tags), so the type belongs in the declaration, not in the name.

Legacy plugins in the ecosystem are saturated with Hungarian prefixes
(`g_iCount`, `szName`, `bEnabled`, `id`); agents trained on that code default
to reproducing it. Apply these rules to every new declaration, parameter, and
constant instead.

## When to use

- Writing a new `.sma` plugin or `.inc` include.
- Adding or editing declarations in existing Pawn code.
- Reviewing or refactoring Pawn for naming/typing consistency.
- Removing Hungarian notation from a legacy plugin.

## When not to use

- Building, packaging, or deploying an AMXX server/project — use the
  `amxb-migration` skill or the `amxb` CLI.
- Non-Pawn languages.

## Core rules

### 1. No Hungarian notation (highest priority)

Never encode type or scope in an identifier. Drop every prefix whose only job
is to restate the type. This rule overrides "match the surrounding code" — a
legacy file's style must not leak into new lines.

| Legacy prefix | Encodes | Modern replacement |
|---|---|---|
| `g_`, `g` | global scope | no prefix — globals are CamelCase (`PlayerScores`) |
| `i`, `j`, `k` | integer | a descriptive name (`count`, `playerIndex`) |
| `sz`, `s`, `str` | string | a descriptive name (`name`, `message`) |
| `b` | boolean | descriptive name + `bool:` tag (`bool:Enabled`) |
| `f`, `fl` | float | descriptive name + `Float:` tag (`Float:Delay`) |
| `p` | pointer / parameter | a descriptive name |
| `a`, `arr` | array | a descriptive name |
| `id` | player index | `playerIndex` (rule 5) |

`bool:` and `Float:` are **tags**, not prefixes: keep them, and keep them
required for boolean/float values. A bare `i`/`j` used only as a trivial
`0..n` loop counter is not type Hungarian and is acceptable; name the index
when it refers to a domain entity (`playerIndex`, `itemIndex`, `weaponId`).

### 2. Variable naming

- **Global variables → `CamelCase`**: `new PlayerScores[MAX_PLAYERS + 1];`
- **Local variables and parameters → `camelCase`**:
  `new damageAmount;`, `DealDamage(playerIndex, Float:damageAmount)`.
- **A string written into a caller buffer → `out[]` + `const outLen`**:
  `FormatName(const playerIndex, out[], const outLen)`. A read-only string
  parameter keeps a descriptive name (`const name[]`).
- Do not reintroduce the scope in the name: a global is `RoundCounter`, never
  `g_RoundCounter`.

### 3. Functions are `PascalCase`

Every function or method name is `PascalCase`, whether it is plain, `static`,
or `public`: `DealDamage`, `GetEffectiveDamage`, `PrintName`. Two families keep
their own names: AMXX-reserved callbacks (`plugin_init`, `plugin_precache`,
`plugin_end`, `client_command`, `client_PreThink`, …) and handlers (rule 9).
AMXX-reserved callbacks are declared `public Name`, never `@Name`: the engine
looks them up by the bare name.

```pawn
DealDamage(playerIndex, Float:damageAmount) {
    // ...
}
```

A plugin's own functions carry no `stock` (rule 12).

### 4. Constants

Scalar constants use a bare `const` (no `new`), which makes them compile-time
constants — usable as an array size (`new buf[MAX_PLAYERS]`) and as a `case`
label:

```pawn
const MAX_RETRIES = 3;
const Float:MOVE_INTERVAL = 0.5;
```

String and array constants use `new const NAME[] = ...` (or `stock const` in a
shared `.inc`). An array constant needs a storage qualifier: a bare `const`
cannot declare an array (`const NAME[] = "..."` fails with `error 001: expected
token: "=", but found "["`), and the size is inferred from the initializer:

```pawn
new const PLUGIN_NAME[] = "My Plugin";
new const WEAPON_IDS[] = {1, 2, 3};
```

A scalar written as `new const MAX_RETRIES = 3;` is a read-only variable, not a
compile-time constant: used as an array size it breaks the compiler, and as a
`case` label it fails with `error 008: must be a constant expression`. Use
`new const` for a scalar only when the value is computed at runtime and merely
needs to be read-only (`new const playerCount = get_playersnum();`).

Inside an include (`.inc`) whose constants may not all be used, use
`stock const` to avoid "symbol is never used" warnings:

```pawn
stock const API_VERSION[] = "1.2.0";
```

Prefer `const` (scalar) and `new const` (array) over `#define` for typed
constants; reserve `#define` for conditional compilation and macros. A `#define`
still uses `UPPER_SNAKE_CASE` strictly, like any constant: a version define is
`STYLE_EXAMPLE_VERSION`, never `StyleExample_VERSION`. The plugin version string
is a deliberate exception to this preference (see `references/metadata.md`).

### 5. The player index is `playerIndex`

Name AMXX player indices `playerIndex`. Never `id`, `pid`, `playerid`, or
`iPlayer`.

```pawn
public client_command(playerIndex) {
    if (!is_user_alive(playerIndex)) {
        return PLUGIN_HANDLED;
    }

    new userHealth = get_user_health(playerIndex);
    server_print("HP: %d", userHealth);
    return PLUGIN_HANDLED;
}
```

Player indices are 1-based; index `0` is the server/world. Account for this
when sizing arrays (rule 7). `is_user_connected(playerIndex)` and
`is_user_alive(playerIndex)` range-check internally: both return `false` for an
index outside `1..maxClients` and never error, and `is_user_alive` implies
connected. A manual `playerIndex < 1 || playerIndex > MAX_PLAYERS` guard before
them is redundant.

### 6. Mark effectively-constant parameters `const`

Mark every parameter the function does not modify as `const` — arrays and
strings **and scalars**. The AMXX compiler enforces this: reassigning a
`const` parameter fails with `error 022: must be lvalue (non-constant)`,
whether it is an array or a scalar. Legacy code marks only string parameters;
extend it to all non-mutated parameters.

```pawn
PrintName(const name[]) {
    server_print("%s", name);
}

GetEffectiveDamage(const baseDamage, const Float:multiplier) {
    return floatround(baseDamage * multiplier);
}
```

### 7. Per-player arrays are sized `MAX_PLAYERS + 1`

`MAX_PLAYERS` is 32, and valid indices run from `0` (server) through 32
inclusive. An array of `MAX_PLAYERS` overflows at index 32. Size any array
indexed by player index as `MAX_PLAYERS + 1` (33):

```pawn
new PlayerDeaths[MAX_PLAYERS + 1];
new bool:PlayerConnected[MAX_PLAYERS + 1];
```

### 8. Booleans use the `bool:` tag

Declare booleans with `bool:` and assign `true`/`false`. Do not keep `0`/`1`
in an untagged cell, and do not name the variable with a `b` prefix.

```pawn
new bool:RoundActive;

if (!RoundActive) {
    RoundActive = true;
}
```

Untagged `0`/`1` works, but `bool:` states intent and enables compile-time checking.

### 9. Handlers

Name a handler after what it handles:

- **Command handlers are `@Cmd_*`**: `@Cmd_Stats`, `@Cmd_Respawn`.
- **Hook and other handlers are `@On*`**: `@OnPlayerSpawn`, `@OnRoundStart`.
  Add a `Post`/`Pre` suffix only when the plugin registers both variants and
  the distinction matters: `@OnPlayerDeathPre` / `@OnPlayerDeathPost`.
- **Native handlers keep `@` + the registered native name**
  (`@StyleExample_AddKill`), so one grep finds both ends. That model lives in
  `references/natives.md`.

`@Name()` is an alternative spelling of `public Name()`, but the `@` is **not**
stripped: the exported name is literally `@Name`. Use `@` only when the caller
resolves that exact string (`register_clcmd`, `RegisterHam`, `register_native`,
`CreateOneForward`, an event bus, …). For AMXX/engine callbacks and declared
`forward`s, write `public Name()` with no `@`: the engine calls the bare name,
so `@Name` is never invoked.

```pawn
public plugin_init() {
    register_clcmd("say /stats", "@Cmd_Stats");
    RegisterHam(Ham_Spawn, "player", "@OnPlayerSpawn", true);
}

@Cmd_Stats(playerIndex) {
    PrintStats(playerIndex);
    return PLUGIN_HANDLED;
}

// AMXX/engine callback: bare public name, no `@`
public client_putinserver(playerIndex) {
    // ...
}
```

Check `CreateOneForward` for `-1`: a string that does not match the declaration
resolves to `-1`, and `ExecuteForward(-1)` silently returns `0`.

Declare only the parameters a handler uses and omit them entirely when unused.
A native handler declares the two parameters `(pluginIndex, paramsCount)` only
when it reads them, and tags its return (see `references/natives.md`).

Index handler arguments through a named enum rather than magic numbers — the
same pattern serves command args and native params. Declare the enum **inside
the handler body**: its members are then local, so every handler can reuse the
same `Arg_*` names without colliding in the file's global namespace.

```pawn
@Cmd_Unban() {
    enum {
        Arg_Key = 1,
        Arg_Template
    }

    new key[16], template[32];
    read_argv(Arg_Key, key, charsmax(key));
    read_argv(Arg_Template, template, charsmax(template));

    return PLUGIN_HANDLED;
}
```

Start with `Arg_Cmd` when the handler needs the command itself
(`{ Arg_Cmd, Arg_Key, … }`); otherwise begin at the first real argument. The
names are a matter of taste — the point is that `read_argv` / `get_param` get a
name, not a literal.

### 10. Braces are mandatory and K&R

Every function definition and every `if` / `else` / `for` / `while` / `do`
body is brace-enclosed, even a single statement. The opening brace always stays
on the same line as the signature or statement, never on its own line:

```pawn
DealDamage(playerIndex, Float:damageAmount) {
    if (is_user_alive(playerIndex)) {
        Heal(playerIndex);
    } else {
        LogDead(playerIndex);
    }
}
```

### 11. No column alignment in code

Do not pad `=` or values with extra spaces inside function bodies or
declarations. One space around `=` is enough:

```pawn
new kills = 0;
new deaths = 0;
```

The aligned `public stock const` metadata block (see `references/metadata.md`)
is a tolerated exception.

### 12. No `stock` functions in plugin code

A plugin's own `.sma` uses plain functions: if a function exists it is used,
otherwise delete it. Reserve `stock` for shared `.inc` files, where it suppresses
"symbol is never used" warnings for consumers that do not call every function.

### 13. `static` functions are file-local

A `static` function is file-local: it does not collide with a same-named
function in another file, but it still cannot share a name with another
declaration in its own file. Use it for encapsulation, not as a namespace.

### 14. Section comments: discouraged, not forbidden

Banner/section comments that carve a file into labelled blocks (e.g.
`// ===== Globals =====`) are **not recommended** but not forbidden. Prefer
names, small functions, and blank lines; reserve a banner for a rare long file
where finding a section is genuinely hard, and keep it minimal. A banner never
substitutes for structure.

### 15. Comments: optional and sparse

Do not add comments by default. A comment is justified only when the code is
genuinely non-obvious and the names cannot express the reason, contract, or edge
case; never restate the code. PawnDoc in a shared `.inc` is API documentation,
not an inline comment. Details: `references/comments.md`.

## Hungarian → modern conversion

| Legacy | Modern |
|---|---|
| `g_iPlayerScore` | `PlayerScore` |
| `g_szPlayerName` | `PlayerName` |
| `g_bRoundActive` | `bool:RoundActive` |
| `g_fSpawnDelay` | `Float:SpawnDelay` |
| `new iCount` | `new count` |
| `szMessage` | `message` |
| `public client_command(id)` | `public client_command(playerIndex)` |
| `new g_iData[33]` | `new Data[MAX_PLAYERS + 1]` |

A complete before/after file lives in `references/legacy-conversion.md`.

## Applying to an existing (legacy) file

- Apply these conventions to the lines you add or change.
- Do not mass-rename untouched code unless the task is explicitly a
  Hungarian-notation cleanup.
- Refactor via the language server / editor rename, not a blind text replace: a
  global `id` → `playerIndex` replacement can corrupt strings and comments.
- Renaming, `const`, and `bool:` additions must not change runtime behavior;
  compile and confirm zero new warnings/errors.

## Gotchas

- **`const` is enforced, not decorative.** Reassigning any `const` parameter —
  scalar included — fails with `error 022: must be lvalue (non-constant)`.
  A `stock` function that is never called has its body dropped before `const`
  checking, so a bug there can hide until the function is used — do not rely
  on an uncalled function to prove a `const` body is legal.
- **Scalar constants are `const`, arrays are `new const`.** `const MAX = 3;` is
  a compile-time constant and works as an array size and a `case` label;
  `new const MAX = 3;` is a read-only variable and fails in those positions, so
  use it for a scalar only when the value is runtime-computed
  (`new const count = get_playersnum();`). Arrays are the reverse:
  `new const NAME[] = ...` parses, but a bare `const NAME[]` does not.
- **`MAX_PLAYERS` is 32, indices include 32.** Size per-player arrays
  `MAX_PLAYERS + 1`.
- **`id` is also the argument name in the AMXX includes.** Rename only your
  own declarations to `playerIndex`; leave the includes' own signatures and
  your call sites as they are.
- **Tags are not prefixes.** Removing `Float:`/`bool:` to "de-Hungarianize" is
  wrong: keep the tag, drop the `f`/`b` name prefix.
- **Do not silence a tag mismatch with `_:`.** Casting a tagged value down with
  `_:` discards the type and hides a real mismatch; fix the tag or the
  declaration instead. The only allowed use of `_:` is the declaration form
  `enum _:S_Name` / `enum _:E_Name`, which strips the enum's own tag at the
  source by design — that is not a cast. `Float:` members inside a struct need
  no cast, and `TrieSetCell` / `TrieGetCell` accept a `Float:` variable
  directly through their `any:` parameters.
- **`@` is part of the name.** A handler declared `@OnKill` is exported as
  `@OnKill`, not `OnKill`; a string that omits the `@` does not resolve it.
  Conversely, AMXX/engine callbacks and declared `forward`s must not carry
  `@`: the engine looks up the bare name.

## Must do

- Drop all type/scope prefixes from new identifiers.
- Name globals `CamelCase`; locals and parameters `camelCase`.
- Name functions `PascalCase` (AMXX-reserved callbacks and handlers excepted).
- Name command handlers `@Cmd_*` and hook handlers `@On*`; omit unused handler
  params.
- Index command and native arguments through a named enum, not literals.
- Use `UPPER_SNAKE_CASE` for scalar `const` / array `new const` / `stock const` /
  `#define` constants.
- Name player indices `playerIndex` and guard them with
  `is_user_alive`/`is_user_connected` instead of a manual range check.
- Mark every non-mutated parameter `const` (scalars included).
- Size player-indexed arrays `MAX_PLAYERS + 1`.
- Tag booleans `bool:` and use `true`/`false`.
- Brace every function and control-flow body and keep it K&R (opening brace on
  the same line).
- Keep code unaligned; reserve column alignment for the metadata block.
- Use `stock` only for functions in shared `.inc` files.
- Prefer self-explanatory names and small functions over banner comments.
- Leave code uncommented unless a comment is the only way to convey a genuinely
  non-obvious constraint.
- Make every `.inc` self-sufficient: a unique include guard plus the headers it
  uses.
- Use `@` only for handlers resolved by an exact string; keep AMXX/engine
  callbacks and declared `forward`s as `public Name`.
- Compile after any refactor and confirm no new warnings or errors.

## Must not do

- Do not introduce `g_`, `i`, `sz`, `b`, `f`, `p`, or `a` type/scope prefixes.
- Do not name a player index `id`.
- Do not name functions `camelCase`.
- Do not use untagged `0`/`1` for a boolean.
- Do not declare a compile-time scalar constant as `new const NAME = value;` —
  use `const NAME = value;` (`new const` stays valid for a runtime-initialized
  read-only scalar; arrays keep `new const NAME[]`).
- Do not size player-indexed arrays `MAX_PLAYERS`.
- Do not encode type in the name — put it in the tag.
- Do not cast a tag away with `_:` to silence a mismatch — fix the tag instead.
  `enum _:S_Name` / `enum _:E_Name` is a declaration form, not a cast.
- Do not use `@` on an AMXX/engine callback or a declared `forward`.
- Do not test `playerIndex < 1 || playerIndex > MAX_PLAYERS` before
  `is_user_connected`/`is_user_alive` — both validate internally.
- Do not write a function or control-flow body without braces, and never put
  the opening brace on its own line.
- Do not column-align `=` or values in code (the metadata block excepted).
- Do not use `stock` functions in a plugin's own `.sma`.
- Do not treat `static` as a namespace — it is file-local isolation only.
- Do not blindly text-replace identifiers when refactoring.
- Do not propagate a legacy file's style into newly added code.
- Do not use banner comments to stand in for structure.
- Do not add comments by default, narrate obvious code, or put a comment on
  every declaration.
- Do not rely on the `.sma` include order to satisfy an `.inc`'s dependencies.

## Verification checklist

- [ ] No identifier carries a type or scope prefix.
- [ ] Globals `CamelCase`; locals and parameters `camelCase`.
- [ ] Functions `PascalCase` (AMXX-reserved callbacks excepted); handlers
  `@Cmd_*` / `@On*`.
- [ ] Unused handler params are omitted.
- [ ] No `_:` cast silently strips a tag from a value or return; any `_:` is
  the declaration form `enum _:S_Name` / `enum _:E_Name`.
- [ ] `@` appears only on handlers resolved by an exact string; AMXX/engine
  callbacks and declared `forward`s use bare `public Name`.
- [ ] Command/native arguments use an `Arg_*` enum declared in the handler body,
  not literals.
- [ ] Constants are `UPPER_SNAKE_CASE`: scalar constants use bare `const`, array
  constants use `new const` / `stock const`, and every `#define` is too.
- [ ] Player index named `playerIndex`, guarded with `is_user_alive` /
  `is_user_connected` and no manual range check.
- [ ] Every non-mutated parameter is `const`.
- [ ] Player-indexed arrays use `MAX_PLAYERS + 1`.
- [ ] Booleans use `bool:` and `true`/`false`.
- [ ] Every function and control-flow body is brace-enclosed and K&R (opening
  brace on the same line).
- [ ] No column alignment in code (metadata block excepted).
- [ ] `stock` functions appear only in shared `.inc` files.
- [ ] Every `.inc` has a unique guard and includes the headers it uses.
- [ ] Comments are rare; none restates the code or the identifier.
- [ ] No banner comments where names and structure would do.
- [ ] Compiles with no new warnings or errors.

## References

Deep, rarely-needed details live in separate files. Open one only when the task
touches that topic.

| Topic | Reference | Load when |
|-------|-----------|-----------|
| Enum roles (`S_` struct, `E_` enumeration, `T_` tag), namespaced tags, `Invalid_*` zero value | `references/enums.md` | Declaring or editing an `enum`, or choosing/using a custom type tag |
| Native registration, `@` handlers, and native error reporting (`log_error` vs `abort`) | `references/natives.md` | Exposing a native via `plugin_natives()`, writing a native handler, or raising an error from a native |
| Reserved plugin metadata symbols | `references/metadata.md` | Declaring `PluginName` / `PluginVersion` / `PluginAuthor` / `PluginDescription` / `PluginURL` |
| String formatting (`format` vs `formatex`, `add`, inline `fmt()`) | `references/strings.md` | Formatting, appending, or building a string |
| Logging (`log_amx` prefix, severity tags) | `references/logging.md` | Writing or reviewing a `log_amx` line |
| Resource cleanup (`Array` / `Trie` / `DataPack`, `plugin_end`) | `references/resource-cleanup.md` | Freeing a dynamic structure, or writing `plugin_end` |
| Include guards, self-sufficient includes, `<...>` vs `"..."`, include cycles, ordering | `references/includes.md` | Authoring or editing an `.inc`, or fixing a dependency that only works in one include order |
| Authoring a shared `.inc` (PawnDoc on natives/forwards) | `references/shared-includes.md` | Authoring or documenting a shared `.inc` |
| Inline comments: when one is justified, what not to comment | `references/comments.md` | Deciding whether to add or remove an inline comment |
| Worked Hungarian → modern before/after file | `references/legacy-conversion.md` | Converting a legacy file, or showing the full mapping |

## Not yet covered (extend here)

Statement formatting beyond brace placement is not specified yet. Include rules
live in `references/includes.md`. Module layout and plugin lifecycle
*architecture* are out of scope: they live in `amxx-plugin-architecture`, which
also carries the review-ready sequence for a multi-file plugin. Resource cleanup
remains the one lifecycle-adjacent rule this guide owns
(`references/resource-cleanup.md`).
