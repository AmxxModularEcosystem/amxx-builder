---
name: amxx-pawn-style
description: >-
  Coding conventions for AMXX Pawn (AMX Mod X / GoldSrc .sma and .inc plugins)
  that eliminate Hungarian notation. Use when writing, editing, refactoring,
  or reviewing Pawn code — variables, constants, enums, type tags, natives, or
  plugin metadata. Enforces CamelCase globals, camelCase locals/parameters, no
  type prefixes (g_, i, sz, b, Float:), enum role prefixes (S_, E_, T_),
  namespaced tags with a named Invalid_* zero value, `new const NAME[]`
  strings, `playerIndex` over `id`, `const` on non-mutated parameters,
  `MAX_PLAYERS + 1` arrays, explicit `bool:`, `@NativeName` handlers
  registered with style 0 (never style 1), and `PluginName`/`PluginVersion`
  metadata. Triggers: AMXX, AMX Mod X, Pawn, Small, .sma, .inc, naming
  convention, native, register_native, plugin metadata, PluginName, type tag,
  Hungarian notation, венгерская нотация, стиль кода. Do NOT use for
  building/packaging/deploying servers (use amxb-migration / the amxb CLI),
  or for non-Pawn languages.
---

# AMXX Pawn code style

Canonical naming and typing conventions for AMXX Pawn (AMX Mod X) code. The
governing goal is to **remove Hungarian notation**: never encode a value's type
or scope in its identifier. Pawn already has real type tags (`Float:`,
`bool:`, custom enum tags), so the type belongs in the declaration, not in the
name. It also fixes the plugin's public surface: how natives are named and
registered, and how metadata is declared.

Legacy plugins in the ecosystem are saturated with Hungarian prefixes
(`g_iCount`, `szName`, `bEnabled`, `id`); agents trained on that code default
to reproducing it. Apply these rules to every new declaration, parameter,
constant, and enum instead.

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
| `id` | player index | `playerIndex` (rule 4) |

`bool:` and `Float:` are **tags**, not prefixes: keep them, and keep them
required for boolean/float values. A bare `i`/`j` used only as a trivial
`0..n` loop counter is not type Hungarian and is acceptable; name the index
when it refers to a domain entity (`playerIndex`, `itemIndex`, `weaponId`).

### 2. Variable naming

- **Global variables → `CamelCase`**: `new PlayerScores[MAX_PLAYERS + 1];`
- **Local variables and parameters → `camelCase`**:
  `new damageAmount;`, `dealDamage(playerIndex, Float:damageAmount)`.
- Do not reintroduce the scope in the name: a global is `RoundCounter`, never
  `g_RoundCounter`.

### 3. Constants

Compile-time constants use `UPPER_SNAKE_CASE` in a `new const` declaration.
String constants follow exactly this form:

```pawn
new const PLUGIN_NAME[] = "My Plugin";
new const MAX_RETRIES = 3;
```

Inside an include (`.inc`) whose constants may not all be used, use
`stock const` to avoid "symbol is never used" warnings:

```pawn
stock const API_VERSION[] = "1.2.0";
```

Prefer `new const` over `#define` for typed constants; reserve `#define` for
conditional compilation and macros. The plugin version string is a deliberate
exception (see Metadata).

### 4. The player index is `playerIndex`

Name AMXX player indices `playerIndex`. Never `id`, `pid`, `playerid`, or
`iPlayer`.

```pawn
public client_command(playerIndex)
{
    if (!is_user_alive(playerIndex))
        return PLUGIN_HANDLED;

    new userHealth = get_user_health(playerIndex);
    server_print("HP: %d", userHealth);
    return PLUGIN_HANDLED;
}
```

Player indices are 1-based; index `0` is the server/world. Account for this
when sizing arrays (rule 6).

### 5. Mark effectively-constant parameters `const`

Mark every parameter the function does not modify as `const` — arrays and
strings **and scalars**. The AMXX compiler enforces this: reassigning a
`const` parameter fails with `error 022: must be lvalue (non-constant)`,
whether it is an array or a scalar. Legacy code marks only string parameters;
extend it to all non-mutated parameters.

```pawn
stock printName(const name[])
{
    server_print("%s", name);
}

getEffectiveDamage(const baseDamage, const Float:multiplier)
{
    return floatround(baseDamage * multiplier);
}
```

### 6. Per-player arrays are sized `MAX_PLAYERS + 1`

`MAX_PLAYERS` is 32, and valid indices run from `0` (server) through 32
inclusive. An array of `MAX_PLAYERS` overflows at index 32. Size any array
indexed by player index as `MAX_PLAYERS + 1` (33):

```pawn
new PlayerDeaths[MAX_PLAYERS + 1];
new bool:PlayerConnected[MAX_PLAYERS + 1];
```

### 7. Booleans use the `bool:` tag

Declare booleans with `bool:` and assign `true`/`false`. Do not keep `0`/`1`
in an untagged cell, and do not name the variable with a `b` prefix.

```pawn
new bool:RoundActive;

if (!RoundActive)
{
    RoundActive = true;
}
```

Untagged `0`/`1` works at runtime, but `bool:` states intent, enables compile
time checking, and removes the need for the legacy `b` prefix.

### 8. Enum roles: `S_`, `E_`, `T_`

An AMXX `enum` serves three roles; the prefix announces which.

**Struct layout → `S_`.** A record whose name is used as the array dimension.
Field names live in the global symbol namespace, so keep them distinct from
your global variable names.

```pawn
enum S_PlayerStats
{
    PlayerKills,
    PlayerDeaths,
    Float:PlayerPlayTime
}

new PlayerStats[MAX_PLAYERS + 1][S_PlayerStats];
PlayerStats[playerIndex][PlayerKills] = 0;
```

**Enumeration → `E_`.** A list of symbolic integer values. Strip the tag the
enum creates with `enum _:` so members can be assigned to plain cells without
`warning 213: tag mismatch`:

```pawn
enum _:E_Team
{
    TeamNone,
    TeamTerrorist,
    TeamCounterTerrorist
}

new playerTeam = TeamTerrorist;
```

**Type / tag → `T_`.** The enum name is used as a tag to give its values a
distinct type. Keep the tag and type the variables. Namespace the tag by
module/system — `T_<System>_<Name>` — so tags from different modules cannot
collide, and declare a named zero value instead of writing an implicit
`Tag:0`:

```pawn
enum T_Weapon_State
{
    Invalid_Weapon_State = 0,
    WeaponIdle,
    WeaponFiring,
    WeaponReloading
}

new T_Weapon_State:weaponState = Invalid_Weapon_State;
```

`Invalid_<System>_<Name>` is the first `enum` member: it is a tagged constant
equal to `0`, so it also works as a default parameter value. An implicit
`Tag:0` literal is untagged and bypasses compile-time checking — use the named
value instead.

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

Before (legacy):

```pawn
new g_iScore[MAX_PLAYERS];
new g_szName[33][32];
new bool:g_bConnected[33];

public client_command(id)
{
    new szMessage[128];
    if (g_bConnected[id])
        formatex(szMessage, charsmax(szMessage), "%s: %d", g_szName[id], g_iScore[id]);
}
```

After:

```pawn
new Score[MAX_PLAYERS + 1];
new PlayerName[MAX_PLAYERS + 1][32];
new bool:PlayerConnected[MAX_PLAYERS + 1];

public client_command(playerIndex)
{
    new message[128];
    if (PlayerConnected[playerIndex])
        formatex(message, charsmax(message), "%s: %d",
                 PlayerName[playerIndex], Score[playerIndex]);
}
```

## Applying to an existing (legacy) file

- Apply these conventions to the lines you add or change.
- Do not mass-rename untouched code unless the task is explicitly a
  Hungarian-notation cleanup.
- Refactor via the language server / editor rename, not a blind text replace —
  a global `id` → `playerIndex` replacement can corrupt strings, comments, and
  unrelated identifiers.
- Renaming, `const`, and `bool:` additions must not change runtime behavior;
  compile and confirm zero new warnings/errors.

## Plugin surface: natives and metadata

The conventions extend to the two things a plugin exposes to the rest of the
server: its natives and its metadata.

### Natives

Name the native handler `@` + the native's full name, and register it through
`plugin_natives()`. Preferring a handler name identical to the registered name
means one grep finds both ends; treat this as a preference, not a hard rule.

```pawn
public plugin_natives()
{
    register_native("Inventory_GiveItem", "@Inventory_GiveItem");
}

@Inventory_GiveItem(pluginId, argc)
{
    // ...
}
```

- `@` already marks the function public, so do not also write `public` on an
  `@` handler.
- `pluginId` is the implicit first parameter of a native handler. AMXX has no
  `GetPluginId()` native, so read the calling plugin's id from this parameter.
- Register with the default style (omit the third argument). Never pass the
  legacy style 1: AMXX keeps it only for compatibility with very old plugins
  and it has known technical problems.

### Metadata

AMXX reads plugin metadata from `public const` string variables whose names
are reserved and exact. Declare them at file scope; `register_plugin` in
`plugin_init` is then optional and kept only for backward compatibility.

```pawn
public stock const PluginName[]        = "My Plugin";
public stock const PluginVersion[]     = MyPlugin_VERSION;
public stock const PluginAuthor[]      = "Author";
public stock const PluginDescription[] = "Short summary";
public stock const PluginURL[]         = "https://example.com/my-plugin";
```

- `PluginName`, `PluginVersion`, and `PluginAuthor` are the baseline.
  `PluginDescription` and `PluginURL` are optional — declare them only when
  they carry real information.
- `PluginVersion` may reuse a `#define`d version from the plugin's public
  include: `#define MyPlugin_VERSION "x.y.z"` there, consumed here. This is
  optional and mostly useful for plugins that ship a public API (the include
  then carries its own version); a self-contained plugin can use a `new const`
  string instead.

## Gotchas

- **`enum Name` creates a tag.** Assigning a member to a plain variable warns
  `warning 213: tag mismatch`. Use `enum _:E_Name` for enums consumed as plain
  integers, or type the variable with the tag (`T_Name:x`).
- **Enum fields share the global namespace.** A field named `PlayerDeaths`
  collides with a global `new PlayerDeaths[]` (`error 021: symbol already
  defined`). Keep field names distinct from global names.
- **`const` is enforced, not decorative.** Reassigning any `const` parameter —
  scalar included — fails with `error 022: must be lvalue (non-constant)`.
  A `stock` function that is never called has its body dropped before `const`
  checking, so a bug there can hide until the function is used — do not rely
  on an uncalled function to prove a `const` body is legal.
- **`MAX_PLAYERS` is 32, indices include 32.** Size per-player arrays
  `MAX_PLAYERS + 1`.
- **`id` is also the argument name in the AMXX includes.** Rename only your
  own declarations to `playerIndex`; keep passing natives unchanged.
- **Tags are not prefixes.** Removing `Float:`/`bool:` to "de-Hungarianize" is
  wrong: keep the tag, drop the `f`/`b` name prefix.
- **`@` is already public.** Writing `public` on an `@` native handler is a
  syntax error — the `@` prefix *is* the public declaration form.
- **Native registration style 1 is legacy.** It survives only for very old
  plugins and has known technical problems; register with the default style.
- **`pluginId` has no getter.** There is no `GetPluginId()` native; the calling
  plugin id arrives as the handler's implicit first parameter.
- **Metadata names are reserved and exact.** `PLUGIN_NAME` / `PLUGIN_VERSION`
  are ordinary constants — AMXX reads only `PluginName` / `PluginVersion` /
  `PluginAuthor` / `PluginDescription` / `PluginURL`.

## Must do

- Drop all type/scope prefixes from new identifiers.
- Name globals `CamelCase`; locals and parameters `camelCase`.
- Use `UPPER_SNAKE_CASE` for `new const` / `stock const` constants.
- Name player indices `playerIndex`.
- Mark every non-mutated parameter `const` (scalars included).
- Size player-indexed arrays `MAX_PLAYERS + 1`.
- Tag booleans `bool:` and use `true`/`false`.
- Name enums by role: `S_` struct, `E_` enumeration (`enum _:`), `T_` tag.
- Namespace type tags `T_<System>_<Name>` and give each a named
  `Invalid_<System>_<Name> = 0` member.
- Register natives with the default style (style 0); prefer `@` + the native's
  full name for the handler.
- Declare metadata with the reserved `PluginName` / `PluginVersion` /
  `PluginAuthor` symbols, adding `PluginDescription` / `PluginURL` only when
  they carry real information.
- Compile after any refactor and confirm no new warnings or errors.

## Must not do

- Do not introduce `g_`, `i`, `sz`, `b`, `f`, `p`, or `a` type/scope prefixes.
- Do not name a player index `id`.
- Do not use untagged `0`/`1` for a boolean.
- Do not size player-indexed arrays `MAX_PLAYERS`.
- Do not encode type in the name — put it in the tag.
- Do not blindly text-replace identifiers when refactoring.
- Do not propagate a legacy file's style into newly added code.
- Do not use an implicit `Tag:0`; use the named `Invalid_*` value.
- Do not use legacy native registration style 1, or write `public` on an `@`
  handler.
- Do not name metadata `PLUGIN_NAME` / `PLUGIN_VERSION`; AMXX reads the exact
  reserved symbols.

## Verification checklist

- [ ] No identifier carries a type or scope prefix.
- [ ] Globals `CamelCase`; locals and parameters `camelCase`.
- [ ] Constants `UPPER_SNAKE_CASE` in `new const` (or `stock const` in `.inc`).
- [ ] Player index named `playerIndex`.
- [ ] Every non-mutated parameter is `const`.
- [ ] Player-indexed arrays use `MAX_PLAYERS + 1`.
- [ ] Booleans use `bool:` and `true`/`false`.
- [ ] Enums prefixed by role; `E_` uses `enum _:` when consumed as integers.
- [ ] Type tags namespaced; each has a named `Invalid_*` zero value, no
  `Tag:0`.
- [ ] Native handlers use `@` + native name (preferred); register with style 0
  (required).
- [ ] Metadata uses the reserved `PluginName` / `PluginVersion` /
  `PluginAuthor` symbols.
- [ ] Compiles with no new warnings or errors.

## Not yet covered (extend here)

Function/method naming, indentation and brace style, `#include` ordering,
statement formatting, and module layout are not specified yet. Plugin
lifecycle (`plugin_precache` as the boot hook, custom-forward orchestration)
is intentionally out of scope: it is architecture, not style, and belongs in a
separate skill.
