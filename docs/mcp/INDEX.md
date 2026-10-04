# MCP сервер — amxx-dep-resolver

MCP сервер даёт AI-агенту (opencode, Claude Desktop и т.д.) доступ к информации о зависимостях AMX Mod X. Позволяет смотреть публичные API плагинов, разрешать `#include`, работать с манифестами, узнавать версии.

## Запуск

```bash
amxb mcp
```

## Подключение

В `.opencode/opencode.json` любого проекта:

```json
{
  "mcp": {
    "amxx-dep-resolver": {
      "type": "local",
      "command": ["amxb", "mcp"],
      "enabled": true
    }
  }
}
```

## Инструменты

| Инструмент | Для чего | Документация |
|---|---|---|
| `get_dep_interface` | Посмотреть содержимое `.inc` файлов зависимости (API, функции, константы) | [→](tools/get_dep_interface.md) |
| `list_dep_incs` | Узнать, какие `.inc` файлы есть в зависимости | [→](tools/list_dep_incs.md) |
| `get_dep_manifest` | Прочитать манифест зависимости и объявленные в нём `docs:`/`skills:` | [→](tools/get_dep_manifest.md) |
| `list_agent_docs` | Список агент-доков текущего проекта или зависимости | [→](tools/list_agent_docs.md) |
| `get_agent_docs` | Прочитать агент-доки текущего проекта или зависимости | [→](tools/get_agent_docs.md) |
| `list_agent_skills` | Список агент-скиллов текущего проекта или зависимости | [→](tools/list_agent_skills.md) |
| `get_agent_skills` | Прочитать агент-скиллы текущего проекта или зависимости | [→](tools/get_agent_skills.md) |
| `get_dep_tree` | Построить дерево зависимостей (кто от кого зависит) | [→](tools/get_dep_tree.md) |
| `resolve_manifest` | Прочитать и развернуть `amxbuild.yml` со всеми переопределениями | [→](tools/resolve_manifest.md) |
| `validate_manifest` | Проверить `amxbuild.yml` на ошибки | [→](tools/validate_manifest.md) |
| `get_cache_info` | Посмотреть, что лежит в кэше сборки | [→](tools/get_cache_info.md) |
| `list_amxmodx_incs` | Список стандартных `.inc` файлов AMXX (amxmodx.inc, core.inc и т.д.) | [→](tools/list_amxmodx_incs.md) |
| `get_amxmodx_include` | Прочитать содержимое стандартных `.inc` файлов AMXX | [→](tools/get_amxmodx_include.md) |
| `resolve_include` | Найти, какой файл скрывается за `#include <...>` | [→](tools/resolve_include.md) |
| `build_include_tree` | Построить дерево `#include` для плагина | [→](tools/build_include_tree.md) |
| `list_releases` | Узнать доступные версии (релизы/тэги) GitHub репозитория | [→](tools/list_releases.md) |

## RPC-инструменты (опционально)

28 дополнительных инструментов управляют **живым** AMX Mod X сервером через модуль `amxx-rpc-module` (RPC по TCP): серверные команды, cvar, игроки, события, фейк-игроки и боты YAPB. Они **скрыты по умолчанию** и регистрируются только когда задан `AMXB_RPC_TOKEN` (и `AMXB_RPC_ENABLED` не равен `0`). Полная документация — в [`tools/rpc.md`](tools/rpc.md).

| Переменная | Обязательность | По умолчанию | Описание |
|------------|:---:|--------------|----------|
| `AMXB_RPC_HOST` | — | `127.0.0.1` | Хост RPC-эндпоинта |
| `AMXB_RPC_PORT` | — | `27016` | Порт модуля (отдельный от игрового/RCon `27015`) |
| `AMXB_RPC_TOKEN` | ✓ | — | Общий секрет (не короче 16 символов), совпадает с `token` в `amxxrpc.cfg` |
| `AMXB_RPC_TIMEOUT` | — | `15` | Таймаут запроса и установки соединения, секунды |
| `AMXB_RPC_ENABLED` | — | — | Явный тумблер; `0` принудительно скрывает инструменты |

| Инструмент | Для чего | Документация |
|---|---|---|
| `rpc_call` | Вызвать произвольный RPC-метод | [→](tools/rpc.md#rpc_call) |
| `rpc_methods` | Каталог методов сервера | [→](tools/rpc.md#rpc_methods) |
| `rpc_status` | Версия RPC-модуля и пинг | [→](tools/rpc.md#rpc_status) |
| `server_exec` | Выполнить серверную команду | [→](tools/rpc.md#server_exec) |
| `cvar_get` | Прочитать cvar | [→](tools/rpc.md#cvar_get) |
| `cvar_set` | Установить cvar | [→](tools/rpc.md#cvar_set) |
| `players_list` | Список игроков | [→](tools/rpc.md#players_list) |
| `player_get` | Данные одного игрока | [→](tools/rpc.md#player_get) |
| `events_subscribe` | Подписаться на событие | [→](tools/rpc.md#events_subscribe) |
| `events_unsubscribe` | Отписаться от события | [→](tools/rpc.md#events_unsubscribe) |
| `events_drain` | Забрать буфер событий | [→](tools/rpc.md#events_drain) |
| `fake_create` | Создать фейк-игрока | [→](tools/rpc.md#fake_create) |
| `fake_remove` | Удалить фейк-игрока | [→](tools/rpc.md#fake_remove) |
| `fake_list` | Список фейк-игроков | [→](tools/rpc.md#fake_list) |
| `fake_get` | Данные фейк-игрока | [→](tools/rpc.md#fake_get) |
| `fake_move` | Двигать фейк-игрока | [→](tools/rpc.md#fake_move) |
| `fake_look` | Задать взгляд фейк-игрока | [→](tools/rpc.md#fake_look) |
| `fake_stop` | Остановить фейк-игрока | [→](tools/rpc.md#fake_stop) |
| `fake_buttons` | Нажать/отпустить кнопки | [→](tools/rpc.md#fake_buttons) |
| `fake_set` | Изменить состояние фейк-игрока | [→](tools/rpc.md#fake_set) |
| `fake_authid` | Задать authid фейк-игрока | [→](tools/rpc.md#fake_authid) |
| `bot_available` | Доступны ли боты YAPB | [→](tools/rpc.md#bot_available) |
| `bot_add` | Добавить бота | [→](tools/rpc.md#bot_add) |
| `bot_list` | Список ботов | [→](tools/rpc.md#bot_list) |
| `bot_goal` | Задать цель бота | [→](tools/rpc.md#bot_goal) |
| `bot_look` | Заставить бота смотреть | [→](tools/rpc.md#bot_look) |
| `bot_freeze` | Заморозить/разморозить бота | [→](tools/rpc.md#bot_freeze) |
| `bot_status` | Состояние бота | [→](tools/rpc.md#bot_status) |

## Локальные источники

`repos:`/`deps:` могут указывать на локальную папку (`source: local` + `path`), а `AMXB_LOCAL_SOURCES` перенаправляет уже объявленные записи на локальные каталоги. Инструменты отражают это так:

- `build_plan` (данные `buildPlanData`): у элементов `repos[]` и `globalDeps[]` есть `source` (`"local"` для локального источника) и `local_dir` (абсолютный путь или `null`); для локальных записей `ref` равен `null`. У git-записей может присутствовать `ref_ttl` — TTL кэша резолва `ref → SHA` (`"never"` или число миллисекунд; поле отсутствует, если в манифесте оно не задано).
- `get_dep_tree`: узлы локальных записей несут `source: "local"` и `localDir` (абсолютный путь).
- `validate_manifest`: локальная запись проходит схему как `{ source: local, path, name? }` (для dep ещё `include_path?`); у локального репо также допустимы `amxmodx_dir`, `plugins`, `exclude`, `exclude_files`, `deps_override`. Поле `plugins` (`{ ini, debug }`) настраивает INI плагинов этого репо; устаревший `plugins_ini_postfix` ещё принимается, но пишет предупреждение при сборке.

```yaml
repos:
  - source: local
    path: ../ProjectA
    name: projecta
deps:
  - source: local
    path: ../Shared
    name: shared
    include_path: scripting/include
```

## Кэш

Все инструменты используют общий кэш (`~/.cache/amxx-builder`). Параметр `no_fetch: true` заставляет работать только с уже закэшированными данными без хождения в сеть.
