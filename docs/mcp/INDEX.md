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
| `get_dep_docs` | Прочитать агент-доки зависимости (best practices, паттерны использования API) | [→](tools/get_dep_docs.md) |
| `list_dep_docs` | Узнать, какие доки есть у зависимости | [→](tools/list_dep_docs.md) |
| `get_dep_tree` | Построить дерево зависимостей (кто от кого зависит) | [→](tools/get_dep_tree.md) |
| `resolve_manifest` | Прочитать и развернуть `amxbuild.yml` со всеми переопределениями | [→](tools/resolve_manifest.md) |
| `validate_manifest` | Проверить `amxbuild.yml` на ошибки | [→](tools/validate_manifest.md) |
| `get_cache_info` | Посмотреть, что лежит в кэше сборки | [→](tools/get_cache_info.md) |
| `list_amxmodx_incs` | Список стандартных `.inc` файлов AMXX (amxmodx.inc, core.inc и т.д.) | [→](tools/list_amxmodx_incs.md) |
| `get_amxmodx_include` | Прочитать содержимое стандартных `.inc` файлов AMXX | [→](tools/get_amxmodx_include.md) |
| `resolve_include` | Найти, какой файл скрывается за `#include <...>` | [→](tools/resolve_include.md) |
| `build_include_tree` | Построить дерево `#include` для плагина | [→](tools/build_include_tree.md) |
| `list_releases` | Узнать доступные версии (релизы/тэги) GitHub репозитория | [→](tools/list_releases.md) |

## Кэш

Все инструменты используют общий кэш (`~/.cache/amxx-builder`). Параметр `no_fetch: true` заставляет работать только с уже закэшированными данными без хождения в сеть.
