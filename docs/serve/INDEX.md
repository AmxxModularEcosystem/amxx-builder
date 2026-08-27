# Serve — JSON-RPC интерфейс `amxb serve`

`amxb serve` — универсальный интерфейс для программного управления сборкой AMX Mod X через **JSON-RPC 2.0 по stdio**. Это не «ещё один CLI»: это постоянный канал, по которому процесс-клиент (редактор, агент, скрипт, CI-инструмент — что угодно) может:

- читать и валидировать манифесты,
- резолвить `#include`, смотреть стандартные инклюды AMXX, строить граф инклюдов `.sma`,
- строить дерево зависимостей,
- запускать полную сборку и **получать прогресс в реальном времени** (push-уведомления),
- компилировать отдельные `.sma`,
- деплоить на сервер и слать RCON-команды,
- запускать watch.

В отличие от вызова `amxb build` + парсинга stdout, serve отдаёт **структурированные данные** и умеет **пушить события** — клиент не опрашивает сервер, сервер сам сообщает о прогрессе.

## Почему JSON-RPC и почему stdio

- **JSON-RPC 2.0** — простой, широко поддерживаемый протокол. Клиент пишет одну JSON-строку в stdin, читает JSON-строки из stdout.
- **stdio** — не нужно открывать порты, нет конфликтов адресов, работает в любом окружении (включая sandbox'ы редакторов). Один процесс `amxb serve` = один клиент; процесс живёт, пока открыт stdin.
- Это тот же транспортный паттерн, что используют LSP и MCP, поэтому клиенты (например, расширения редакторов) уже знают, как с ним работать.

## Запуск

```bash
amxb serve
```

Запускается из корня проекта (там, где лежит `amxbuild.yml`). Альтернативно — `node src/commands/serve.js` из репозитория.

Сразу после запуска сервер слушает stdin. Никакого handshake не требуется — можно отправлять запросы. Сервер завершается, когда stdin закрывается (EOF).

### Окружение

| Аспект | Поведение |
|---|---|
| **stdout** | Только JSON-RPC (строки). Никаких логов, прогресс-баров, `console.log`. |
| **stderr** | Логи и ошибки сервера (в т.ч. ошибки notification-хендлеров). |
| **`.env`** | Загружается из рабочей директории (cwd) при старте. Методы с `manifest`-параметром, резолвящие GitHub-токены (`repos.*`, `releases.list`, `deps.tree`, `include.resolve`, `include.list`, `dep-graph.get`, `compile.single`, ...), дополнительно подгружают `.env` рядом с манифестом — он **первичен** (перекрывает cwd), cwd-`.env` служит фолбеком, если рядом с манифестом его нет. |
| **GITHUB_TOKEN** | Берётся из `.env` / окружения; приватные репо работают как в CLI. |

### Пример клиента за 30 секунд (Node.js)

```js
const { spawn } = require('child_process');
const child = spawn('amxb', ['serve'], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const msg = JSON.parse(buf.slice(0, idx));
    buf = buf.slice(idx + 1);
    if (msg.id != null) {
      console.log('Ответ:', msg.result ?? msg.error);
      child.stdin.end(); // закрываем stdin → сервер завершится
    }
  }
});

child.stdin.write(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'manifest.validate', params: { manifest: 'amxbuild.yml' },
}) + '\n');
```

## Протокол

Строки на stdin/stdout — по одному JSON-объекту на строку (line-delimited).

**Запрос** (клиент → сервер, ожидает ответ):

```json
{"jsonrpc":"2.0","id":1,"method":"manifest.validate","params":{"manifest":"amxbuild.yml"}}
```

**Успешный ответ:**

```json
{"jsonrpc":"2.0","id":1,"result":{...}}
```

**Ошибка:**

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Manifest not found: /x/amxbuild.yml"}}
```

**Уведомление от сервера** (push, без `id` — ответ не ожидается):

```json
{"jsonrpc":"2.0","method":"build.stage","params":{"stage":"compile","message":"Compiling plugins"}}
```

### Коды ошибок

| Код | Значение | Когда возникает |
|---|---|---|
| `-32700` | Parse error | Строка не является валидным JSON (сервер пытается извлечь `id` из строки) |
| `-32601` | Method not found | Неизвестный метод |
| `-32602` | Invalid params | Отсутствует/невалиден обязательный параметр (см. методы ниже) |
| `-32603` | Internal error | Ошибка внутри core-логики. Для GitHub-ошибок (`repos.*`, `releases.list`) содержит структурированные детали в `error.data = { "status", "repo", "message" }` |
| `-32000` | Server error | Конфликт состояния: `build.start` при уже идущей сборке, `watch.start` при уже активном watcher'е |

## Методы

### Манифест

#### `manifest.validate`

Проверить манифест против схемы. **Никогда не бросает** — ошибки в результате.

| Параметр | Тип | Описание |
|---|---|---|
| `manifest` | string | Путь к `amxbuild.yml` (по умолчанию автоопределение в cwd) |

```json
{"id":1,"method":"manifest.validate","params":{}}
```

Ответ:

```json
{
  "valid": true,
  "errors": [],
  "warnings": []
}
```

#### `manifest.resolve`

Полностью развернуть манифест: прочитать YAML, смержить с дефолтами, применить `set`/`define`.

| Параметр | Тип | Описание |
|---|---|---|
| `manifest` | string | Путь к манифесту (по умолчанию автоопределение) |
| `set` | string[] | Переопределения через dot-нотацию, напр. `["version=1.2", "output.pack=false"]` |
| `define` | string[] | Доп. define'ы компилятора, напр. `["DEBUG"]` |

Ответ — объект развёрнутого манифеста (см. `resolveManifest` в `src/manifest.js`): `name`, `version`, `amxmodx`, `repos`, `deps`, `assets`, `output`, `github`, ... плюс служебное поле `_path`.

### Инклюды

#### `include.resolve`

Резолв `#include`-директивы: найти, какой файл за ней стоит, и вернуть его путь и источник.

| Параметр | Тип | Описание |
|---|---|---|
| `directive` | string | `"#include <amxmodx>"`, `"#include \"ColorChat\""`, `<amxmodx>`, `amxmodx` — префикс необязателен |
| `include` | string | Алиас для `directive` |
| `sma_file` | string | Путь к `.sma`, из которого идёт инклюд (нужен для `"quoted"`-поиска локально) |
| `manifest` | string | Путь к манифесту для подключения deps в поиск |
| `version` | string | Переопределить версию AMXX для stdlib |
| `no_fetch` | boolean | Не ходить в сеть, только кэш |

Порядок поиска: локальная папка `.sma` (для `"quoted"`) → **deps манифеста** → **stdlib AMXX** (deps перед stdlib — как в реальной сборке). Сначала точное совпадение, затем case-insensitive.

Ответ:

```json
{
  "found": true,
  "filename": "amxmodx.inc",
  "absPath": "/home/user/.cache/amxx-builder/amxxpc/1.10.5428/linux/include/amxmodx.inc",
  "source": "AMXX stdlib 1.10.5428",
  "searched": ["local (current directory)", "AMXX stdlib 1.10.5428"],
  "errors": []
}
```

Если не найдено: `{"found": false, "filename": "...", "searched": [...], "errors": [...]}`.

#### `include.list`

Список `.inc` файлов всех зависимостей манифеста.

| Параметр | Тип | Описание |
|---|---|---|
| `manifest` | string | Путь к манифесту (обязателен, должен существовать) |
| `no_fetch` | boolean | Только кэш |

Ответ:

```json
{
  "manifest": "/project/amxbuild.yml",
  "deps": [
    {
      "repo": "AmxxModularEcosystem/ParamsController",
      "ref": "1.4.0",
      "include_path": null,
      "include_dir": "/home/user/.cache/amxx-builder/repos/...",
      "count": 5,
      "files": [{"rel": "params_controller.inc", "abs": "/path/params_controller.inc"}]
    }
  ]
}
```

Ошибки по отдельным deps не роняют запрос — dep получает `{"error": "...", "files": [], "count": 0}`.

### Стандартные инклюды AMXX

#### `amxmodx.includes.list`

Список `.inc` из стандартного бандла компилятора.

| Параметр | Тип | Описание |
|---|---|---|
| `manifest` | string | Для определения версии из `amxmodx.version` |
| `version` | string | Версия AMXX (по умолчанию: из манифеста, иначе latest) |
| `pattern` | string | Glob-фильтр (по умолчанию `*.inc`) |

Ответ: `{ "version", "includeDir", "pattern", "count", "files": ["amxmodx.inc", ...] }`.

#### `amxmodx.include.get`

То же, но с содержимым файлов.

| Параметр | Тип | Описание |
|---|---|---|
| `file` | string | Имя файла или glob (по умолчанию `*.inc`) |

Ответ: `{ "version", "includeDir", "count", "files": [{"rel": "core.inc", "content": "..."}] }`.

### Дерево зависимостей

#### `deps.tree`

Рекурсивное дерево зависимостей с детекцией циклов и `deps_override`.

| Параметр | Тип | Описание |
|---|---|---|
| `manifest` | string | Построить дерево из манифеста (repos + globalDeps, учитывая `deps_override`) |
| `deps` | array | Вместо манифеста: массив строк (`"owner/repo@ref"`) или объектов `{repo, ref, source?, include_path?, asset?}` |
| `depth` | number | Макс. глубина (0 = без ограничений) |
| `token` | string | GitHub PAT |
| `no_fetch` | boolean | Только кэш |

Ответ — дерево из `buildDepTree` (см. `src/deps-tree.js`): `{ "dependencies": [...] }` с полями `repo`, `ref`, `resolvedRef`, `source`, `from`, `error`, `cycle`, `shared`, `dependencies`.

### Граф `#include`-зависимостей

#### `dep-graph.get`

Построить граф инклюдов для `.sma`-файла: какие файлы парсятся, какие инклюды резолвятся и какие отсутствуют. Include-пути ищутся в том же порядке, что и в реальной сборке (deps → stdlib).

| Параметр | Тип | Описание |
|---|---|---|
| `sma_file` | string | **Обязателен**, путь к `.sma` |
| `manifest` | string | Для deps и версии AMXX (опционально) |
| `version` | string | Переопределить версию AMXX |
| `include_dirs` | string[] | Дополнительные папки поиска |
| `no_fetch` | boolean | Только кэш |
| `inc` | string | Обратный запрос: путь к `.inc` → какие `.sma` от него транзитивно зависят |

Ответ:

```json
{
  "sma_file": "/project/scripting/hello.sma",
  "version": "1.10.5428",
  "include_dirs": ["/home/user/.cache/amxx-builder/repos/...", "/home/user/.cache/amxx-builder/amxxpc/1.10.5428/linux/include"],
  "files": [
    {"file": "/project/scripting/hello.sma", "isSma": true, "includes": ["/project/scripting/include/colorchat.inc"]},
    {"file": "/project/scripting/include/colorchat.inc", "isSma": false, "includes": []}
  ],
  "missing": [{"file": "/project/scripting/hello.sma", "name": "nonexistent", "isAngle": true}]
}
```

При `inc` — дополнительное поле `smas_depending_on` (массив путей `.sma`, транзитивно зависящих от указанного `.inc`). Это та же логика, что использует watch для выбора плагинов на пересборку.

### Релизы / кэш / план

#### `releases.list`

Список GitHub-релизов или тэгов репозитория.

| Параметр | Тип | Описание |
|---|---|---|
| `repo` | string | **Обязателен**, `"owner/repo"` |
| `tags` | boolean | Список тэгов вместо релизов |
| `limit` | number | Макс. результатов (по умолчанию 10) |
| `includeAssets` | boolean | Детали ассетов релизов |
| `manifest` | string | Абсолютный путь до `amxbuild.yml` — для резолюции токена (`github.tokens[owner]` / `github.token_env`) |
| `token` | string | GitHub PAT (фолбек, если токена нет в манифесте) |

Ответ — массив релизов/тэгов (см. `listReleases`/`listTags` в `src/release-lister.js`).

Ошибка GitHub API (в т.ч. 404 на несуществующее репо) — `-32603` с `error.data = { "status": 404, "repo": "owner/repo", "message": "..." }`. Клиент по `status` различает: `404` — «не существует или нет доступа» (warning), `403`/`429` — rate-limit, остальное — общая ошибка. В отличие от методов `repos.*`, 404 здесь остаётся ошибкой, а не `{ exists: false }` — проверка существования репо идёт через `repos.info`.

### Репозитории (GitHub)

Методы для проверки и изучения репозиториев — подсказки в `repos`/`deps` и диагностика «репо существует?». Общие конвенции:

- **Токен-модель**: манифест (per-owner `github.tokens[owner]` → глобальный `github.token_env`, по умолчанию `GITHUB_TOKEN`) → параметр `token` → анонимно. `.env` рядом с манифестом подгружается автоматически.
- **404 от GitHub — не ошибка**: ответ `{ "exists": false, "reason": "not_found_or_no_access" }`. GitHub намеренно отдаёт 404 и для несуществующих, и для приватных/недоступных репо — различить их нельзя даже с токеном.
- **Ошибки GitHub** (403 rate-limit, 429, 5xx, сеть) — `-32603` с `error.data = { "status", "repo", "message" }` (`status` — HTTP-статус, `null` при сетевой ошибке).

#### `repos.info`

Проверка, что репозиторий существует и доступен, + метаданные.

| Параметр | Тип | Описание |
|---|---|---|
| `repo` | string | **Обязателен**, `"owner/repo"` |
| `manifest` | string | Абсолютный путь до манифеста — для резолюции токена |
| `token` | string | Явный токен-фолбек |

Ответ (репо существует):

```json
{
  "repo": "AmxxModularEcosystem/amxx-builder",
  "exists": true,
  "private": false,
  "archived": false,
  "disabled": false,
  "defaultBranch": "main",
  "description": "Build and package AMX Mod X server plugins",
  "pushedAt": "2026-08-24T23:47:41Z"
}
```

| Поле | Тип | Описание |
|---|---|---|
| `repo` | string | `"owner/repo"` из запроса |
| `exists` | boolean | `true` для существующего репо |
| `private` / `archived` / `disabled` | boolean | Флаги репо (`archived: true` — клиент предупреждает «не обновлять») |
| `defaultBranch` | string \| null | Ветка по умолчанию |
| `description` | string \| null | Описание репо |
| `pushedAt` | string \| null | ISO-дата последнего пуша (подсказка «заброшен», сортировка) |

Ответ (не найдено / нет доступа) — HTTP 200, не ошибка:

```json
{ "repo": "octocat/this-repo-does-not-exist", "exists": false, "reason": "not_found_or_no_access" }
```

#### `repos.branches`

Список веток (подсказки `repos[].ref` / `deps[].ref` — теги отдаёт `releases.list(tags: true)`).

| Параметр | Тип | Описание |
|---|---|---|
| `repo` | string | **Обязателен**, `"owner/repo"` |
| `manifest` | string | Абсолютный путь до манифеста — для резолюции токена |
| `token` | string | Явный токен-фолбек |
| `limit` | number | Макс. веток (по умолчанию 10, максимум 100) |
| `page` | number | Пагинация (по умолчанию 1) |

Ответ:

```json
{
  "repo": "AmxxModularEcosystem/amxx-builder",
  "branches": [
    { "name": "main", "commitSha": "fe35d0db7959bbe1253a6031a5e10b900c723dba" },
    { "name": "dev",  "commitSha": "0b7e6f..." }
  ]
}
```

`commitSha` — SHA головы ветки (бесплатно из GitHub-ответа, пригодится для диагностики). Пустой репозиторий (без коммитов) → `{ "repo": ..., "branches": [] }`. Не найдено / нет доступа → `{ "exists": false, "reason": "not_found_or_no_access" }`.

#### `repos.structure`

Файлы/папки репозитория (подсказки `repos[].amxmodx_dir`, `repos[].exclude` / `exclude_files`).

| Параметр | Тип | Описание |
|---|---|---|
| `repo` | string | **Обязателен**, `"owner/repo"` |
| `ref` | string | Ветка/тег/SHA. По умолчанию — default branch (сервер резолвит через запрос метаданных репо — он же проверяет существование) |
| `manifest` | string | Абсолютный путь до манифеста — для резолюции токена |
| `token` | string | Явный токен-фолбек |
| `depth` | number | Глубина обхода от корня (1 = только верхний уровень). По умолчанию 1; **если задан `ext`, а `depth` опущен — без ограничения** (весь файл-дерево) |
| `dirsOnly` | boolean | Только директории (для `amxmodx_dir`) |
| `ext` | string[] | Только файлы с этими расширениями, напр. `["sma"]` (для `exclude`) |
| `maxEntries` | number | Лимит записей в ответе (по умолчанию 500, максимум 2000) |

Ответ:

```json
{
  "repo": "AmxxModularEcosystem/CustomWeaponsAPI",
  "ref": "main",
  "truncated": false,
  "entries": [
    { "path": "amxmodx", "type": "dir" },
    { "path": "scripting", "type": "dir" },
    { "path": "scripting/CWAPI-A-Test.sma", "type": "file" }
  ]
}
```

| Поле | Тип | Описание |
|---|---|---|
| `repo` | string | `"owner/repo"` |
| `ref` | string \| null | Реально использованный ref (после резолва default branch — её имя; если передан — как передан) |
| `truncated` | boolean | `true`, если достигнут `maxEntries` или дерево обрезано GitHub'ом (лимит 100k записей) |
| `entries` | array | `{ path, type: "dir" \| "file" }`, относительные пути от корня, разделитель `/` |

Семантика фильтров: `dirsOnly: true` → только `type: "dir"`; `ext: ["sma"]` → только файлы `.sma` (рекурсивно, директории отфильтровываются); `depth: N` ограничивает записи глубиной ≤ N от корня. `ref: "latest"` не поддерживается (это семантика релизов, а не структуры).

Ошибки: несуществующий `ref` (ветка/тег) у **существующего** репо — `-32603` с `error.data.status = 404`, message «Ref not found: \<ref\>». Trees API отдаёт 404 и для отсутствующего репо, и для несуществующего ref — сервер перепроверяет существование репо через `repos.info`, чтобы их различить (422 бывает только для невалидного 40-hex SHA). Пустой репозиторий (409) — успех с `entries: []`; 404 на репо — `{ "exists": false, "reason": "not_found_or_no_access" }`.

#### `cache.info`

Содержимое кэша сборки.

| Параметр | Тип | Описание |
|---|---|---|
| `manifest` | string | Дополнительно проверить локальный кэш `.amxb-cache/` |

Ответ — разбивка по `amxxpc`/`repos`/`release-deps`/`local` с размерами (см. `getCacheInfo` в `src/cache-info.js`).

#### `compiler.info`

Информация о компиляторе `amxxpc`: версия, платформа, пути к бинарнику и stdlib-инклюдам.

| Параметр | Тип | Описание |
|---|---|---|
| `manifest` | string | Для определения версии из `amxmodx.version` |
| `version` | string | Версия AMXX (по умолчанию: из манифеста, иначе latest) |
| `no_fetch` | boolean | Не качать — только состояние кэша |

Ответ:

```json
{
  "version": "1.10.5428",
  "platform": "linux",
  "compilerPath": "/home/user/.cache/amxx-builder/amxxpc/1.10.5428/linux/amxxpc",
  "includeDir": "/home/user/.cache/amxx-builder/amxxpc/1.10.5428/linux/include",
  "cached": true
}
```

Без `no_fetch` компилятор будет скачан при первом обращении (как в обычной сборке); с `no_fetch: true` ответ отражает только текущее состояние кэша (`compilerPath: null`, если компилятор ещё не скачан).

#### `build.plan`

План сборки без выполнения (аналог `amxb build --dry-run`) — структурированный JSON.

| Параметр | Тип | Описание |
|---|---|---|
| `manifest` | string | Путь к манифесту |
| `set` / `define` | string[] | Переопределения (как в `manifest.resolve`) |
| `detailedAssets` | boolean | Развёрнутая информация об ассетах (`map`, `source`, `cache`, файлы локальных) |
| `listLocal` | boolean | Листинг файлов локальных ассетов (по умолчанию true) |

Ответ — объект `buildPlanData` (см. `src/build-plan.js`): `name`, `version`, `compiler`, `repos`, `deps`, `assets`, `output`, ...

### Сборка

#### `build.start`

Запустить полную сборку. **Долгий запрос**: ответ придёт только когда сборка завершится. Пока сборка идёт, сервер пушит уведомления (см. ниже).

| Параметр | Тип | Описание |
|---|---|---|
| `manifest` | string | Путь к манифесту (по умолчанию автоопределение) |
| `set` / `define` | string[] | Переопределения |
| `buildDir` | string | Папка сборки (по умолчанию `./build`) |
| `fetch` | boolean | `false` = не клонировать (только кэш) |
| `archive` | boolean | `false` = не упаковывать в архив |

Ответ:

```json
{"ok": true, "elapsed": "12.3", "noArchive": false}
```

Ошибка — не `error`-ответ, а результат с флагом:

```json
{"ok": false, "message": "Compilation failed (1/2): broken.sma"}
```

Отмена (по `build.cancel`):

```json
{"ok": false, "cancelled": true, "message": "Build cancelled"}
```

Во время сборки только одна активная сборка; повторный `build.start` → ошибка `-32000 Build already running`.

**Уведомления** (push во время сборки):

| Метод | Параметры | Когда |
|---|---|---|
| `build.stage` | `{"stage": "compiler\|repos\|deps\|collect\|assets\|compile\|ini\|archive", "message": "..."}` | Смена этапа |
| `build.compiled` | `{"baseName": "x.sma", "ok": true, "output": "...", "amxxName": "x.amxx", "repo": "...", "ref": "..."}` | Каждый скомпилированный плагин |
| `build.progress` | `{"label": "...", "current": 50, "total": 100}` | Прогресс загрузок/архивации |
| `build.done` | `{"ok": true, "elapsed": "12.3", "noArchive": false, "message": "Done in 12.3s"}` | Успешное завершение |
| `build.error` | `{"ok": false, "message": "..."}` | Ошибка сборки |

`build.done`/`build.error` приходят **до** ответа на `build.start` — клиент может ориентироваться и на то, и на другое.

#### `build.cancel`

Отменить активную сборку.

Ответ: `{"ok": true}` — или `{"ok": false, "error": "No build running"}`, если сборки нет.

### Компиляция одного файла

#### `compile.single`

Скомпилировать один `.sma` через amxxpc (версия и include-пути резолвятся как в реальной сборке — deps перед stdlib).

| Параметр | Тип | Описание |
|---|---|---|
| `sma_file` | string | **Обязателен**, путь к `.sma` |
| `manifest` | string | Для версии AMXX и deps (опционально) |
| `version` | string | Переопределить версию AMXX |
| `include_dirs` | string[] | Дополнительные `-i` папки |
| `scripting_root` | string | Корень `scripting/` для вычисления относительного имени |
| `no_fetch` | boolean | Только кэш |

Ответ:

```json
{
  "ok": true,
  "amxxName": "hello.amxx",
  "output": "AMX Mod X Compiler 1.10.0.5428\n...\nDone.\n",
  "output_path": "/tmp/amxb-serve-compile/amxmodx/plugins/hello.amxx",
  "dep_errors": []
}
```

При ошибке — `{"ok": false, "amxxName": null, "output": "<вывод amxxpc с текстом ошибок>", "output_path": null, "dep_errors": [...]}`. Поле `output` содержит полный вывод компилятора (текст ошибок компиляции) — как в уведомлениях `build.compiled` полной сборки. Определения компилятора (`-D`) берутся из `amxmodx.defines` манифеста.

### Деплой

Методы деплоя копируют файлы из `buildDir` (по умолчанию `./build`) в целевой путь из `deploy.path`. Требуют настроенный деплой — либо `deploy.path` в манифесте, либо `AMXB_DEPLOY_PATH` в `.env`. Исключения (`deploy.exclude`) соблюдаются, как в CLI.

#### `deploy.start`

Полный деплой `build/amxmodx/` и `build/assets/`.

| Параметр | Тип | Описание |
|---|---|---|
| `manifest` | string | Путь к манифесту |
| `buildDir` | string | Папка сборки (по умолчанию `./build`) |
| `set` / `define` | string[] | Переопределения манифеста |
| `incremental` | boolean | Копировать только изменённые файлы (по mtime) |

Ответ: `{"ok": true, "copied": 42}` — или `{"ok": false, "message": "Deploy path not configured..."}`.

#### `deploy.file`

Задеплоить один файл (например, скомпилированный `.amxx`) — то же, что делает watch при изменении файла.

| Параметр | Тип | Описание |
|---|---|---|
| `relPath` | string | **Обязателен**, путь относительно корня секции |
| `section` | string | `"amxmodx"` (по умолчанию) или `"assets"` |
| `manifest` | string | Путь к манифесту |
| `buildDir` | string | Папка сборки — для hot-reload передавайте `buildDir` из `compile.single` (`output_path`) |

Ответ: `{"ok": true, "dest": "/server/addons/amxmodx/plugins/x.amxx"}` — `ok: false` если файл не задеплоен (нет `deploy.path`, нет исходника, или файл в `deploy.exclude`).

#### `deploy.remove`

Удалить задеплоенный файл (watch при удалении локального файла).

| Параметр | Тип | Описание |
|---|---|---|
| `relPath` | string | **Обязателен**, путь относительно корня секции |
| `section` | string | `"amxmodx"` (по умолчанию) или `"assets"` |
| `manifest` | string | Путь к манифесту |

Ответ: `{"ok": true, "dest": "/server/addons/amxmodx/plugins/x.amxx"}`.

### RCON

#### `rcon.send`

Отправить команду RCON на GoldSrc-сервер (HL1 / CS 1.6, UDP).

| Параметр | Тип | Описание |
|---|---|---|
| `command` | string | **Обязателен**, команда, напр. `"amxx list"` |
| `host` | string | Хост (по умолчанию: из `deploy.rcon.host` манифеста) |
| `port` | number | Порт (по умолчанию: из `deploy.rcon.port`, иначе 27015) |
| `password` | string | Пароль (по умолчанию: из `deploy.rcon.password` манифеста) |
| `manifest` | string | Манифест с конфигурацией `deploy.rcon` |

Если `host`/`password` не переданы — берутся из `deploy.rcon` манифеста (с интерполяцией `${VAR}`). Ответ: `{"ok": true, "response": "<ответ сервера>"}`. При недоступном сервере — ошибка `-32603` (timeout).

### Watch

#### `watch.start`

Запустить watch: сервер следит за изменениями и пушит уведомления. Сама пересборка/deploy в serve-режиме не выполняется — интерфейс отдаёт события, реагировать на них — задача клиента.

| Параметр | Тип | Описание |
|---|---|---|
| `manifest` | string | Путь к манифесту |

Ответ: `{"ok": true, "watching": "/project/amxbuild.yml"}`.

**Уведомления `watch.changed`**:

| kind | Доп. параметры | Значение |
|---|---|---|
| `sma` | `path` | Изменён `.sma` |
| `inc` | `path` | Изменён `.inc` |
| `file` | `rel`, `section` | Изменён другой файл |
| `delete` | `rel`, `section` | Файл удалён |
| `manifest` | — | Изменён манифест |

#### `watch.stop`

Остановить watch. Ответ: `{"ok": true}` — или `{"ok": false, "error": "No watcher running"}`.

### Health check

#### `serve.ping`

Проверка, что канал жив, без побочных эффектов.

Без параметров. Ответ:

```json
{"ok": true, "pid": 12345, "version": "1.5.2", "node": "v22.22.2"}
```

Удобно вызывать первым при подключении клиента.

## Полный список методов

| Метод | Категория | Что делает | Core-функция |
|---|---|---|---|
| `manifest.validate` | manifest | Валидация манифеста | `validate.validateManifestFile` |
| `manifest.resolve` | manifest | Развёрнутый манифест | `manifest.resolveManifest` |
| `include.resolve` | include | Резолв `#include` | `include-tree.parseIncludeDirective` + `searchIncludeFile` |
| `include.list` | include | `.inc` файлы deps | `include-tree.fetchDepIncludeDir` + `collectIncFiles` |
| `amxmodx.includes.list` | include | Список stdlib `.inc` | `compiler-fetcher.fetchCompiler` + glob |
| `amxmodx.include.get` | include | Содержимое stdlib `.inc` | `compiler-fetcher.fetchCompiler` + glob + read |
| `deps.tree` | deps | Дерево зависимостей | `deps-tree.buildDepTree` + `assembleRootDeps` |
| `dep-graph.get` | deps | Граф `#include`-зависимостей `.sma` | `dep-graph.DepGraph` (`parseFile` + `snapshot` + `getSmasDependingOn`) |
| `releases.list` | releases | Релизы/тэги GitHub | `release-lister.listReleases`/`listTags` |
| `repos.info` | repos | Существование + метаданные репо | `github-api.getRepoInfo` |
| `repos.branches` | repos | Ветки репозитория | `github-api.listBranches` |
| `repos.structure` | repos | Файлы/папки репозитория | `github-api.getRepoStructure` |
| `cache.info` | cache | Содержимое кэша | `cache-info.getCacheInfo` |
| `compiler.info` | compiler | Информация об amxxpc | `compiler-fetcher.getCompilerInfo` |
| `build.plan` | build | План без выполнения | `build-plan.buildPlanData` |
| `build.start` | build | Полная сборка + прогресс | `build-service.runBuild` |
| `build.cancel` | build | Отмена сборки | AbortController |
| `compile.single` | compile | Компиляция одного `.sma` (+ вывод) | `compiler.compileSingle` |
| `deploy.start` | deploy | Полный деплой build/ | `deployer.deployBuild` |
| `deploy.file` | deploy | Деплой одного файла | `deployer.deployFile` |
| `deploy.remove` | deploy | Удаление задеплоенного файла | `deployer.removeDeployedFile` |
| `rcon.send` | rcon | RCON-команда на сервер | `rcon.sendRcon` |
| `watch.start` | watch | Подписка на изменения | `watcher.startWatch` |
| `watch.stop` | watch | Остановка watch | `watcher.close` |
| `serve.ping` | serve | Health-check канала | — (pid/version) |

**Уведомления**: `build.stage`, `build.compiled`, `build.progress`, `build.done`, `build.error`, `watch.changed`.

## Практические советы

- **Демо-клиент.** `examples/amxb-live.js` в репозитории — готовый пример клиента: живой дашборд сборки (этапы, прогресс, результат) через `build.start`, с опцией `--watch` для потока `watch.changed`. Ноль зависимостей, работает и в TTY, и в пайпе.
- **Один клиент на процесс.** `amxb serve` обслуживает один stdin-канал. Для нескольких потребителей запустите несколько процессов или реализуйте прокси.
- **Автоопределение манифеста** работает от cwd процесса, в котором запущен `amxb serve`. Чтобы явно указать проект — запускайте из его корня или передавайте `manifest` в каждый запрос.
- **Сеть.** Запросы, которые тянут репозитории/релизы/компилятор (`repos.*`, `releases.list`, `include.list`, `deps.tree`, `build.start`, ...), ходят в GitHub API и могут быть медленными или упереться в rate-limit (403/429 — см. `error.data.status`). `no_fetch: true` ограничивает работу кэшем там, где это применимо.
- **Долгие запросы.** `build.start` отвечает только по завершении сборки; не блокируйте чтение stdout на время сборки — читайте уведомления, иначе буфер stdout переполнится.
- **Ошибки депов не роняют запрос.** Там, где это осмысленно, частичные ошибки попадают в `errors`/`dep_errors` результата, а не в `error`-ответ.

## Архитектурные заметки (для контрибьюторов)

- Реализация: `src/commands/serve.js` — тонкий адаптер (~0 доменной логики), транспорт: `src/jsonrpc-transport.js` (generic JSON-RPC 2.0 over stdio, в ядре).
- Каждый метод — маппинг «нормализуй аргументы → вызови core-функцию → оформи результат». Если поведение нужно более чем одному интерфейсу — оно должно жить в `src/` (правило AGENTS.md: no duplication).
- `mcp/mcp-server.js` — это тот же `JsonRpcServer`, обёрнутый в MCP-протокол; MCP-сервер (`amxb mcp`) и serve используют общий транспорт, но разные методы.
- Для отладки: логи сервера идут в stderr, stdout — чистый JSON-RPC.
