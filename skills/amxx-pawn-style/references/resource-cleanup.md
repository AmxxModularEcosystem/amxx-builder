# Resource cleanup and `plugin_end`

Do not free AMXX-managed dynamic structures in `plugin_end` just because the
plugin is unloading. Structures created through natives and owned by AMXX — the
`Array` / `Trie` / `DataPack` family (`ArrayCreate`, `TrieCreate`,
`CreateDataPack`, …) and other handle-returning natives — are destroyed by AMXX
when the plugin unloads. Releasing them again from `plugin_end` (`ArrayDestroy`,
`TrieDestroy`, `DestroyDataPack`, …) is dead work: it is redundant, it implies
an ownership the engine already holds, and it hides the real teardown in a
destructor pass that can never run on any other path.

Release a structure when its lifetime ends *during* the plugin — clearing
per-round state, dropping a per-map cache, freeing a large buffer early — not
when the whole plugin is going away. Write `plugin_end` only for teardown work
that is genuinely required and that AMXX does not perform for you.

## Checklist

- [ ] No `ArrayDestroy` / `TrieDestroy` / … in `plugin_end` for an
  AMXX-owned structure (AMXX frees it on unload).
- [ ] A structure is freed where its lifetime actually ends during the plugin.
