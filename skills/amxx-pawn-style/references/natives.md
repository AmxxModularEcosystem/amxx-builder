# Native registration in AMXX Pawn

How to expose a native, name its handler, and read the caller's arguments.

## Contents

- [Registering a native](#registering-a-native)
- [Reporting errors from a native handler](#reporting-errors-from-a-native-handler)
- [Gotchas](#gotchas)
- [Checklist](#checklist)

## Registering a native

Name the native handler `@` + the native's full name, and register it through
`plugin_natives()`. `register_native(name, handler, style = 0)` defaults to
**style 0**, the only style to use; style 1 is broken and deprecated, kept only
for very old plugins. The `@` prefix *is* the public declaration form, so never
also write `public` on the handler.

```pawn
public plugin_natives()
{
    register_native("StyleExample_AddKill", "@StyleExample_AddKill");
}
```

A style-0 handler receives exactly two positional parameters: the calling
plugin's id and the argument count. Those are its only parameters; the native's
declared arguments are **not** handler parameters. Read and write them with the
native accessors, which are 1-based:

| Need | Read | Write |
|---|---|---|
| integer argument `n` | `get_param(n)` | `set_param_byref(n, value)` |
| float argument `n` | `get_param_f(n)` | `set_float_byref(n, Float:value)` |
| integer by-ref argument `n` | `get_param_byref(n)` | `set_param_byref(n, value)` |
| float by-ref argument `n` | `get_float_byref(n)` | `set_float_byref(n, Float:value)` |
| string argument `n` | `get_string(n, dest[], len)` | `set_string(n, dest[], len)` |
| array argument `n` | `get_array(n, dest[], size)` | `set_array(n, dest[], size)` |
| float array argument `n` | `get_array_f(n, dest[], size)` | `set_array_f(n, dest[], size)` |

Declare the two handler parameters only when the handler reads them; otherwise
omit them entirely. They are positional, so it is both or neither. A native or
forward declaration in a shared `.inc` is documented with a PawnDoc block:

```pawn
/**
 * Adds a kill to a player's statistics.
 *
 * @param playerIndex   Player index (1..maxClients)
 *
 * @return              true on success, false on an invalid index
 * @error               Invalid player index
 */
native bool:StyleExample_AddKill(const playerIndex);

/**
 * Broadcasts a message to every connected player.
 *
 * @param message       Message text
 */
native StyleExample_Announce(const message[]);

/**
 * Called after a player's statistics change.
 *
 * @param playerIndex   Player index (1..maxClients)
 * @param statKind      One of the E_StatKind values
 * @param statValue     New value of the stat
 */
forward StyleExample_OnStatChanged(const playerIndex, const statKind, const statValue);
```

A handler that needs neither positional parameter omits both and reads the
native's own arguments with the accessors:

```pawn
@StyleExample_AddKill()
{
    enum {
        Arg_PlayerIndex = 1
    }

    new playerIndex = get_param(Arg_PlayerIndex);

    if (!is_user_connected(playerIndex)) {
        return false;
    }

    // ... update stats for playerIndex ...
    return true;
}

@StyleExample_Announce()
{
    enum {
        Arg_Message = 1
    }

    new message[192];
    get_string(Arg_Message, message, charsmax(message));

    // ... broadcast message ...
    return 1;
}
```

The enum is declared inside the handler body (SKILL.md rule 9), so its members
are local and every handler can reuse the same `Arg_*` names.

A handler that needs the argument count declares the pair (`pluginIndex` is
unused but positional), and writes a by-ref string with `set_string`:

```pawn
@StyleExample_GetRankName(pluginIndex, paramsCount)
{
    enum {
        Arg_PlayerIndex = 1,
        Arg_Out,
        Arg_OutLen
    }

    if (paramsCount != 3) {
        return 0;
    }

    new playerIndex = get_param(Arg_PlayerIndex);
    new rankName[32];

    // ... fill rankName for playerIndex ...

    set_string(Arg_Out, rankName, charsmax(rankName));
    return 1;
}
```

A native handler declares the **tag of its return** and returns the tagged
value directly. Never cast a tag away with `_:` just to fit an untagged return —
that discards the type and hides a mismatch:

```pawn
bool:@StyleExample_AddKill()
{
    // ...
    return true;
}

T_StyleExample_Rank:@StyleExample_GetRank()
{
    // ...
    return PlayerRank[playerIndex];   // already T_StyleExample_Rank
}
```

A handler that returns a plain untagged value (a count, a length) carries no
tag. When the return is a custom-tagged value, that tag belongs in the shared
`.inc` so callers share it, e.g.
`native T_StyleExample_Rank:StyleExample_GetRank(const playerIndex);`.

## Reporting errors from a native handler

`log_error` is not a logging call and not a general native — it is a
dynamic-native helper that works only inside a handler registered with
`register_native`. `abort` is a core native usable from any code. They differ in
who is blamed and whether the handler stops:

| | `log_error(error, fmt, …)` | `abort(error, fmt, …)` |
|---|---|---|
| Valid in | a `register_native` handler only | any plugin code |
| Blamed plugin | the **calling** plugin (the one that called your native) | the **currently executing** plugin — the native's owner |
| Caller observes | the error you raised, on the caller; the caller aborts at the call site | `Unhandled dynamic native error`; the caller aborts |
| Handler keeps running after the call? | **yes** — `log_error` returns `1`; only the caller aborts | **no** — the handler aborts at that point |

Constraints the inline doc hides (`log_error` is marked `@noreturn`, but only
from the caller's point of view):

- `log_error` does not stop the handler. It records the error, returns `1`, and
  the raise happens *after* the handler returns, against the caller. Do not rely
  on it to break control flow.
- Outside a `register_native` handler it is a no-op — nothing consumes the
  recorded error, and it is discarded at the next native dispatch.
- It still works from a nested helper (plain or `public`), not only at the
  handler's top level; the error is attributed to the caller either way.
- If the handler also hits a real AMX error, that error wins and the
  `log_error` message is dropped.

Prefer `log_error` when a single guard sits in the handler and the fault is the
caller's. When several natives share one validation, move it into a shared
helper and choose deliberately: a `log_error` there still blames the caller but
does not halt the handler, while `abort` halts immediately from any function at
the cost of blaming your own plugin instead of the caller.

## Gotchas

- **`@` is already public.** Writing `public` on an `@` native handler is a
  syntax error — the `@` prefix *is* the public declaration form.
- **Native registration style 1 is legacy.** It survives only for very old
  plugins and has known technical problems; register with the default style.
- **The native's arguments are not handler parameters.** There is no
  `GetPluginId()`; the calling id arrives as the handler's first positional
  parameter, and the native's own arguments are read with `get_param` /
  `get_string` / … (1-based), never declared in the handler signature.

## Checklist

- [ ] The native handler is `@` + the native's full name (preferred).
- [ ] No `public` is written on an `@` handler.
- [ ] Registration uses style 0 (the default), never style 1.
- [ ] The native's arguments are read/written with `get_param` / `get_string` /
  `set_string` / … (1-based), not declared as handler parameters.
- [ ] Native arguments are indexed through a named `Arg_*` enum, not literals.
- [ ] The two positional handler parameters (`pluginIndex`, `paramsCount`) are
  declared only when used, otherwise omitted entirely.
- [ ] A `log_error` call sits inside a `register_native` handler (it is a no-op
  anywhere else) and the handler does not assume it stopped execution.
- [ ] A shared validation helper that must halt the handler uses `abort`, not
  `log_error`.
- [ ] A native handler declares the tag of its return; no `_:` cast swallows a
  tag.
- [ ] A custom-tagged native return shares its tag via the `.inc`.
