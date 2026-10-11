# Logging in AMXX Pawn

`log_amx` already prefixes every line with the emitting plugin's name — the
`.amxx` filename as listed in `plugins.ini`, not the `PluginName` title. Do not
add the plugin's own name or tag to the message; it duplicates what AMXX writes:

```pawn
// redundant — AMXX already emits "[style_example.amxx] ..."
log_amx("[StyleExample] round started");
// right
log_amx("round started");
```

A severity marker at the front of the message is different, and welcome: a
leading `[INFO]` / `[WARN]` / `[ERR]` / `[DBG]` tag (pick one scheme and keep it)
makes the line easy to scan after AMXX has prepended the filename:

```pawn
log_amx("[WARN] %d players exceeded the limit", overflowCount);
```

This is about `log_amx` only. Player-facing output (`client_print`) has no
automatic prefix, so keep whatever tag those lines need.

## Checklist

- [ ] No `log_amx` message repeats the plugin name (AMXX prepends the `.amxx`
  filename).
- [ ] `log_amx` lines carry a severity tag; `client_print` lines keep their own.
