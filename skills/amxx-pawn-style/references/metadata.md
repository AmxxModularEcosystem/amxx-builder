# Plugin metadata in AMXX Pawn

The reserved `public const` symbols AMXX reads to identify a plugin.

## Declaring metadata

AMXX reads plugin metadata from `public const` string variables whose names
are reserved and exact. Declare them at file scope. Even with those variables
present, still call `register_plugin(...)` explicitly in `plugin_init`: the
reserved-symbol mechanism only exists in newer AMXX builds, and
`register_plugin` is what identifies the plugin on older versions that do not
read the metadata variables yet.

```pawn
public stock const PluginName[]        = "My Plugin";
public stock const PluginVersion[]     = MY_PLUGIN_VERSION;
public stock const PluginAuthor[]      = "Author";
public stock const PluginDescription[] = "Short summary";
public stock const PluginURL[]         = "https://example.com/my-plugin";
```

- `PluginName`, `PluginVersion`, and `PluginAuthor` are the baseline.
  `PluginDescription` and `PluginURL` are optional — declare them only when
  they carry real information.
- `PluginVersion` may reuse a `#define`d version from the plugin's public
  include: define `#define MY_PLUGIN_VERSION "x.y.z"` there (UPPER_SNAKE_CASE,
  like any constant), consumed here. This is optional and mostly useful for
  plugins that ship a public API (the include then carries its own version); a
  self-contained plugin can use a `new const` string instead.

## Gotcha

- **Metadata names are reserved and exact.** `PLUGIN_NAME` / `PLUGIN_VERSION`
  are ordinary constants — AMXX reads only `PluginName` / `PluginVersion` /
  `PluginAuthor` / `PluginDescription` / `PluginURL`.

## Checklist

- [ ] `register_plugin(...)` is still called explicitly in `plugin_init`, even
  though the metadata variables are present.
- [ ] Metadata is declared as `public const` (or `public stock const`) string
  variables at file scope.
- [ ] The reserved symbols `PluginName` / `PluginVersion` / `PluginAuthor` are
  present.
- [ ] `PluginDescription` / `PluginURL` are declared only when they carry real
  information.
- [ ] No `PLUGIN_NAME` / `PLUGIN_VERSION` naming is used.
- [ ] A `#define`d version, if reused, comes from the plugin's public include
  and is `UPPER_SNAKE_CASE` (`MY_PLUGIN_VERSION`, never `MyPlugin_VERSION`).
