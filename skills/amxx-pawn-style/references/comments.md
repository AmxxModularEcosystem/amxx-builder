# Comments in AMXX Pawn

Inline comments are optional and sparse. They are not required, and they are not
a substitute for a clear name, a smaller function, or a split.

## Contents

- [When a comment is justified](#when-a-comment-is-justified)
- [What not to comment](#what-not-to-comment)
- [PawnDoc is different](#pawndoc-is-different)
- [Checklist](#checklist)

## When a comment is justified

A comment is justified only when the code is genuinely non-obvious and the
names around it cannot express the reason, contract, or edge case. When one is
truly needed, explain the non-obvious part — never restate the code or the
identifier.

```pawn
// The forward may fire before the store exists; ignore the early call.
if (!StoreReady) {
    return;
}
```

If a block needs a comment to say what it does, prefer a better name, a smaller
function, or a split.

## What not to comment

Do not add comments by default. Do not comment every function, declaration, or
obvious branch. These are noise:

```pawn
new kills = 0; // kills
kills++;       // increment kills

RegisterKey(key); // register the key
```

A comment that repeats the identifier, the statement, or a format string adds no
information; delete it.

## PawnDoc is different

PawnDoc blocks in a shared `.inc` (`/** ... */` above a `native` or `forward`)
are API documentation, not inline comments. They remain mandatory for `native`
and `forward`, and the sparse-comment rule does not apply to them.

## Checklist

- [ ] Comments are rare, not present by default.
- [ ] No comment restates the code or the identifier.
- [ ] Each comment covers a genuinely non-obvious reason, contract, or edge case.
- [ ] PawnDoc blocks on `native` / `forward` are kept as API documentation.
