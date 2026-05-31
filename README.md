# amxx-builder

CLI-инструмент для сборки AMX Mod X серверов. Читает `amxbuild.yml`, клонирует плагины с GitHub, компилирует `.sma → .amxx` и упаковывает всё в готовый `.zip`.

## Установка

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/install.ps1 | iex
```

**Linux / macOS**:

```bash
curl -fsSL https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/install.sh | bash
```

Для приватных репозиториев передайте GitHub PAT:

```powershell
$env:GITHUB_TOKEN="ghp_xxx"; irm .../install.ps1 | iex
```

Требования: **Node.js 16+**, **git**.

## Использование

```bash
amxb build                          # amxbuild.yml в текущей папке
amxb build --manifest path/to.yml   # явный путь
amxb build --dry-run                # показать план без выполнения
amxb build --no-fetch               # использовать кэш, без клонирования
amxb build --no-archive             # только скомпилировать, без .zip

amxb deploy                         # задеплоить build/ на сервер
amxb deploy --build                 # сначала собрать, потом задеплоить

amxb watch                          # следить за изменениями и деплоить
amxb watch --no-deploy              # только пересобирать, без деплоя

amxb init                           # создать amxbuild.yml в текущей папке
amxb init --deploy                  # + создать .env с заготовками для деплоя
amxb init --plugin <name>           # + создать amxmodx/scripting/<name>.sma
amxb init --workflow                # + создать .github/workflows/ci.yml

amxb clean                          # очистить build/ и кэш клонов
amxb clean --all                    # + кэш компилятора
amxb cache info                     # показать содержимое кэша
```

Кэш хранится в `%LOCALAPPDATA%\amxx-builder` (Windows) или `~/.cache/amxx-builder` (Unix).  
Переопределить: `AMXX_BUILDER_CACHE=/path amxb build`.

## Манифест

Минимальный — только имя и список репо:

```yaml
name: MyServer
repos:
  - AmxxModularEcosystem/VipModular
  - AmxxModularEcosystem/CustomWeaponsAPI
```

Это автоматически:

- берёт последнюю версию компилятора
- клонирует default branch каждого репо
- берёт всё содержимое папки `amxmodx/` из каждого репо
- компилирует все `.sma` из `amxmodx/scripting/`
- упаковывает в `{name}/addons/amxmodx/` внутри архива

## Структура репо плагина

Инструмент ожидает папку `amxmodx/` в корне каждого репо:

```text
amxmodx/
  scripting/
    my_plugin.sma        ← компилируется в plugins/my_plugin.amxx
    SubDir/
      other.sma          ← компилируется в plugins/SubDir/other.amxx
    include/             ← используется компилятором
  configs/
    my_plugin.cfg        ← копируется как есть
  lang/
    my_plugin.txt        ← копируется как есть
```

Имя папки переопределяется через `amxmodx.dir` (глобально) или `amxmodx_dir` (на репо).

## Локальные файлы

Рядом с `amxbuild.yml` можно положить:

```text
my-server/
  amxbuild.yml
  amxmodx/               ← мержится в addons/amxmodx/ (конфиги, доп. файлы)
    configs/
      server.cfg
  assets/                ← включается по умолчанию (source: local)
    models/
      weapon.mdl
    sound/
      weapon.wav
```

## Управление локальными плагинами

Поле `plugins:` позволяет фильтровать и распределять плагины из `amxmodx/scripting/` по INI-файлам. Применяется **только к локальным** плагинам; плагины из репо используют `plugins_ini_postfix` своего репо. Первое совпадение побеждает.

```yaml
plugins_ini_postfix: myserver   # глобальный постфикс → plugins-myserver.ini

plugins:
  - match: "VipM/*.sma"
    ini: vipm             # → plugins-vipm.ini
  - match: "utils/*.sma"
    ini: false            # компилировать, но не включать ни в один INI
  - match: "wip/*.sma"
    enabled: false        # полностью пропустить (не компилировать, не деплоить)
```

| Поле | По умолчанию | Описание |
| --- | --- | --- |
| `match` | — | Glob-паттерн относительно `scripting/` |
| `enabled` | `true` | `false` — пропустить компиляцию и деплой |
| `ini` | `plugins_ini_postfix` | Постфикс INI, `false` — не включать в INI |

## Удалённые ассеты

Поле `assets.sources` позволяет добавлять файлы из разных источников. По умолчанию источником является локальная папка `assets/` (`source: local`).

При явном указании `sources:` нужно включить `source: local` явно, если нужны локальные ассеты:

```yaml
assets:
  # on_conflict: last_wins   # last_wins (default) / first_wins

  sources:
    - source: local           # assets/ рядом с манифестом

    # Базовый amxmodx (modules, plugins и т.д.)
    - source: amxmodx
      map:
        - from: addons/amxmodx/modules/
          to: addons/amxmodx/modules/

    # Архив — всё содержимое в корень ассетов
    - url: https://cdn.example.com/pack.zip
      cache: local           # none (default) / local (.amxb-cache/) / global (~/.cache/)

    # Архив — несколько правил из одного источника
    - url: https://cdn.example.com/full-pack.zip
      map:
        - from: resource/models/   # содержимое папки → models/
          to: models/
        - from: resource/sound/
          to: sound/

    # Одиночный файл
    - url: https://cdn.example.com/weapon.wav
      to: sound/weapons/

    # Одиночный файл с переименованием (to без trailing slash)
    - url: https://cdn.example.com/pistol_v2.mdl
      to: models/v_pistol.mdl

    # GitHub release asset — использует тот же кэш, что и deps
    - source: release
      repo: org/weapon-pack
      ref: v2.0.0
      asset: "weapon-models.zip"
      map:
        - from: models/
          to: models/
        - from: sound/
          to: sound/
```

**Семантика `from` / `to` (trailing slash = содержимое папки):**

| `from` | `to` | Результат |
| --- | --- | --- |
| *(нет)* | *(нет)* | весь архив / файл → корень ассетов |
| `models/` | `models/` | содержимое `models/` → `assets/models/` |
| `models` | `models/` | папка целиком → `assets/models/models/` |
| `sound/gun.wav` | `sound/` | файл → `assets/sound/gun.wav` |
| `sound/gun.wav` | `sound/pistol.wav` | файл с переименованием |

## Деплой и watch

Создайте `.env` рядом с манифестом (`amxb init --deploy`):

```env
AMXB_DEPLOY_PATH=/home/user/hlds/cstrike
AMXB_DEPLOY_RCON_HOST=127.0.0.1
AMXB_DEPLOY_RCON_PORT=27015
AMXB_DEPLOY_RCON_PASSWORD=secret
AMXB_DEPLOY_RCON_CMD=amxx load {plugin}
```

Или задайте прямо в манифесте (поддерживается `${VAR}` интерполяция):

```yaml
deploy:
  path: /home/user/hlds/cstrike    # корень сервера (где лежат addons/, models/)
  amxmodx_path: addons/amxmodx     # default: addons/amxmodx
  watch_debounce_ms: 500           # мс стабильности файла перед ребилдом (default: 500)
  exclude:                         # пути от deploy.path, которые не перезаписываются
    - addons/amxmodx/configs/      # сохранить конфиги сервера
    - addons/amxmodx/configs/amxx.cfg
  rcon:
    host: 127.0.0.1
    port: 27015
    password: ${RCON_PASSWORD}
    command: "amxx load {plugin}"  # {plugin} = имя без .amxx; пусто = не слать
```

`amxb watch` отслеживает изменения в `amxmodx/` и `assets/`:

- `.sma` → пересобрать плагин, задеплоить `.amxx`, послать RCON
- `.inc` → пересобрать только плагины, зависящие от этого инклюда (по `#include`/`#tryinclude`)
- остальные файлы → задеплоить напрямую
- манифест → полная пересборка

## GitHub Actions

```yaml
uses: AmxxModularEcosystem/amxx-builder@v0
```

### Инпуты

| Инпут | По умолчанию | Описание |
| --- | --- | --- |
| `manifest` | `./amxbuild.yml` | Путь к манифесту |
| `build-dir` | `./build` | Директория сборки |
| `version` | — | Переопределяет `manifest.version` |
| `archive-name` | — | Переопределяет `output.archive_name` |
| `set` | — | Переопределить любое поле манифеста (multiline, `key=value`) |
| `no-fetch` | `false` | Пропустить клонирование (использовать кэш раннера) |
| `no-archive` | `false` | Только компиляция, без упаковки |
| `github-token` | `${{ github.token }}` | GitHub токен для приватных репо |

### Выходы

| Выход | Описание |
| --- | --- |
| `name` | Имя проекта из манифеста (`manifest.name`) |

### Полный пример воркфлоу

Манифест плагина (`amxbuild.yml`):

```yaml
name: MyPlugin

amxmodx:
  version: "1.10.5428"

deps:
  - AmxxModularEcosystem/ParamsController@1.4.2
```

Воркфлоу (`.github/workflows/ci.yml`):

```yaml
name: CI

on:
  push:
    branches: [master, feature/**, fix/**]
    paths-ignore:
      - "**.md"
  pull_request:
    types: [opened, reopened, synchronize]
  release:
    types: [published]

jobs:
  build:
    name: Build
    runs-on: ubuntu-latest
    outputs:
      sha:  ${{ steps.sha.outputs.SHORT }}
      name: ${{ steps.build.outputs.name }}
    steps:
      - uses: actions/checkout@v4

      - id: sha
        run: echo "SHORT=$(git rev-parse --short HEAD)" >> $GITHUB_OUTPUT

      - id: build
        uses: AmxxModularEcosystem/amxx-builder@v0
        with:
          set: |
            output.pack=false
            output.dir=./artifact

      - uses: actions/upload-artifact@v4
        with:
          name: ${{ steps.build.outputs.name }}-${{ steps.sha.outputs.SHORT }}-dev
          path: artifact/

  publish:
    name: Publish release
    runs-on: ubuntu-latest
    needs: [build]
    if: |
      github.event_name == 'release' &&
      github.event.action == 'published' &&
      startsWith(github.ref, 'refs/tags/')
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: ${{ needs.build.outputs.name }}-${{ needs.build.outputs.sha }}-dev
          path: artifact/

      - name: Package for release
        run: |
          cd artifact
          zip -r "../${{ needs.build.outputs.name }}-${{ github.ref_name }}.zip" .

      - uses: softprops/action-gh-release@v2
        with:
          files: "${{ needs.build.outputs.name }}-*.zip"
```

Для приватных репо и зависимостей передай PAT:

```yaml
      - id: build
        uses: AmxxModularEcosystem/amxx-builder@v0
        with:
          github-token: ${{ secrets.MY_PAT }}
```

## Локальная сборка (замена build.bat)

`repos:` не обязателен. Если не указан — инструмент работает только с локальными файлами.
Чтобы архив начинался с имени пакета (как при дистрибуции плагина), используй шаблон `{name}` в путях — это уже поведение по умолчанию:

```yaml
name: VipModular
version: "5.0.0"
```

Результат:

```text
VipModular.zip
  VipModular/
    addons/amxmodx/
      plugins/vip_core.amxx
      configs/...
      lang/...
    models/...
  README.md
```

Полный пример: [`example/amxbuild.local.yml`](example/amxbuild.local.yml).

## ref: latest

```yaml
repos:
  - repo: AmxxModularEcosystem/VipModular
    ref: latest   # автоматически берёт тег последнего GitHub release
```

## Полный пример

Все доступные опции: [`example/amxbuild.yml`](example/amxbuild.yml).

## Приоритеты

| Что | Порядок (↑ выше) |
| --- | --- |
| плагины `plugins:` | правила применяются по порядку, первое совпадение побеждает |
| `plugins_ini_postfix` | правило `plugins:` → репо → глобальный |
| зависимости | `manifest.deps` → `deps_override` → `DEPS_LIST` файл в репо |
| ассеты | порядок в `sources:` + `on_conflict` |
| версия компилятора | `amxmodx.version` → последний релиз |
| значения манифеста | `--set` → манифест проекта → `defaults/amxbuild.defaults.yml` |
