# Authoring a shared `.inc`

A shared `.inc` is the public surface other plugins compile against, so its
declarations are documented.

A shared `.inc` follows the skill's include conventions: a unique include guard
and explicit includes for every header it uses, so it compiles in any include
order without the consumer preparing the way.

Every declaration in a shared `.inc` carries a PawnDoc block — the `/** ... */`
comment directly above the declaration. It is mandatory for `native` and
`forward`, desirable for `stock`, constants, and enums, and may be skipped only
when the declaration is self-evident. Document each parameter and the return,
and use `@error` for an error the caller can hit. PawnDoc is API documentation,
not an inline comment; the skill's sparse-comment rule does not apply to it.

```pawn
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

## Checklist

- [ ] The file has a unique include guard and includes every header it uses.
- [ ] Every `native` and `forward` carries a PawnDoc block (mandatory).
- [ ] `stock`, constants, and enums are documented unless self-evident.
- [ ] Each documented parameter and the return are described.
- [ ] PawnDoc is treated as API documentation, not as an inline comment.
