# Legacy conversion example

The rule table in `SKILL.md` maps the common prefixes. This reference shows one
complete before/after file.

Before (legacy):

```pawn
new g_iScore[MAX_PLAYERS];
new g_szName[33][32];
new bool:g_bConnected[33];

public client_command(id) {
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

public client_command(playerIndex) {
    new message[128];

    if (PlayerConnected[playerIndex]) {
        formatex(message, charsmax(message), "%s: %d", PlayerName[playerIndex], Score[playerIndex]);
    }
}
```
