# Enum roles in AMXX Pawn

How to declare an AMXX `enum` so its role is obvious, its members stay
distinguishable, and its type tag cannot collide with another module's.

## Contents

- [The three roles](#the-three-roles)
- [Enum members carry an enum prefix](#enum-members-carry-an-enum-prefix)
- [Gotchas](#gotchas)
- [Checklist](#checklist)

## The three roles

An AMXX `enum` serves three roles; the prefix announces which.

**Struct layout → `S_`.** A record whose name is used as the array dimension.
Field names live in the global symbol namespace, so keep them distinct from
your global variable names.

```pawn
enum S_PlayerStats
{
    PS_Kills,
    PS_Deaths,
    Float:PS_PlayTime
}

new PlayerStats[MAX_PLAYERS + 1][S_PlayerStats];
PlayerStats[playerIndex][PS_Kills] = 0;
```

**Enumeration → `E_`.** A list of symbolic integer values. Strip the tag the
enum creates with `enum _:` so members can be assigned to plain cells without
`warning 213: tag mismatch`:

```pawn
enum _:E_Team
{
    Team_None,
    Team_Terrorist,
    Team_CounterTerrorist
}

new playerTeam = Team_Terrorist;
```

**Type / tag → `T_`.** The enum name is used as a tag to give its values a
distinct type. Keep the tag, type the variables, and declare a named zero value
instead of writing an implicit `Tag:0`.

Namespace the tag by module/system — `T_<System>_<Name>` — only when the tag is
exported in a shared `.inc`, so tags from different modules cannot collide:

```pawn
enum T_Weapon_State
{
    Invalid_Weapon_State = 0,
    Weapon_Idle,
    Weapon_Firing,
    Weapon_Reloading
}

new T_Weapon_State:weaponState = Invalid_Weapon_State;
```

A tag used only inside one plugin is `T_<Name>`, with a matching zero value:

```pawn
enum T_Rank
{
    Invalid_Rank = 0,
    Rank_Rookie,
    Rank_Regular,
    Rank_Veteran
}

new T_Rank:playerRank = Invalid_Rank;
```

`Invalid_<System>_<Name>` (or `Invalid_<Name>`) is the first `enum` member: a
tagged constant equal to `0`, so it also works as a default parameter value. An
implicit `Tag:0` literal is untagged and bypasses compile-time checking — use
the named value instead.

## Enum members carry an enum prefix

Enum members are untyped globals: they live in the file's global namespace and
carry no tag of their own. Every member therefore starts with a prefix naming
the enum it comes from, so members stay distinguishable and two enums cannot
both define a bare `Kills`:

- `S_PlayerStats` → `PS_Kills`, `PS_Deaths`
- `E_Team` → `Team_None`, `Team_Terrorist`
- `T_Rank` → `Rank_Rookie`, `Rank_Veteran`

The prefix is the enum's own name (role prefix stripped) followed by `_`; a
short abbreviation such as `PS_` is fine. Apply the same form to every member of
that enum. The `T_` sentinel is the exception: it is `Invalid_<...>` (above),
not `<Prefix>_...`.

## Gotchas

- **`enum Name` creates a tag.** Assigning a member to a plain variable warns
  `warning 213: tag mismatch`. Use `enum _:E_Name` for enums consumed as plain
  integers, or type the variable with the tag (`T_Name:x`).
- **Enum members share the global namespace.** A member named
  `PlayerStatKills` still lives alongside your globals, so choose a prefix that
  does not clash with them; `new PlayerDeaths[]` and a member `PlayerDeaths`
  would both collide (`error 021: symbol already defined`).
- **`T_<System>_<Name>` is only for shared includes.** A tag that never leaves
  the plugin does not need a system segment; `T_<Name>` avoids implying a
  public, shared type.

## Checklist

- [ ] Every `enum` is prefixed by role: `S_` struct, `E_` enumeration
  (`enum _:`), `T_` tag.
- [ ] Every enum member carries a prefix naming its enum, applied consistently.
- [ ] An `E_` enumeration consumed as plain integers uses `enum _:`.
- [ ] A `T_` tag exported in a shared `.inc` is `T_<System>_<Name>`; an
  internal tag is `T_<Name>`.
- [ ] Each `T_` type has a named `Invalid_<...> = 0` member; no implicit
  `Tag:0` is used.
- [ ] Enum member names do not collide with global variable names.
