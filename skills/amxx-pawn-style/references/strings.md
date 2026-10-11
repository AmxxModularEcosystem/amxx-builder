# String formatting in AMXX Pawn

`format` and `formatex` both write their result starting at destination
position `0`. Neither appends: every call replaces the destination from the
start. The append helper is `add()`.

## `format` vs `formatex`

- `format(dest, len, fmt, ...)` performs an overlap check: if `dest` is also one
  of the sources, it copies the result back safely. That safety costs a little
  speed.
- `formatex(dest, len, fmt, ...)` writes directly, with no overlap check. It is
  faster, but `dest` must not be one of its sources.
- `add(dest, len, fmt, ...)` appends to the current contents of `dest`.

```pawn
new message[192];
formatex(message, charsmax(message), "%s | kills %d", name, kills); // no overlap, fastest
add(message, charsmax(message), " | K/D %d", ratio);                // append
```

## Inline `fmt()`

`native [MAX_FMT_LENGTH]fmt(const format[], any:...);` returns a formatted
string usable inline: the compiler reserves a hidden return buffer of
`MAX_FMT_LENGTH`, which is 256. AMXX docs advise using it for simple inline
formatting and against storing the result into a variable (that copies it out
of the hidden buffer).

```pawn
client_print(playerIndex, print_chat, "%s", fmt("kills: %d", kills));
```

## Custom `fmt`-like local functions

A local helper that builds a string works when it fills and returns its own
buffer:

```pawn
BuildLabel(const value)
{
    new label[32];
    formatex(label, charsmax(label), "value %d", value);
    return label;
}
```

Avoid `return fmt(...)`-style constructs: returning copies the hidden inline
buffer (and can alias a source), so reserve `fmt()` for direct call-site use.
