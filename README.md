# amxx-builder

CLI-инструмент для сборки AMX Mod X серверов. Читает `amxbuild.yml`, клонирует плагины с GitHub, компилирует `.sma → .amxx` и упаковывает всё в готовый `.zip`.

## Установка

**Через npm** (Node.js 18+):

```bash
npm i -g amxx-builder
```

Команды `amxb` и `amxx-builder` станут доступны глобально. Управление версиями — стандартное для npm:

```bash
npm i -g amxx-builder@1.5.1   # конкретная версия
npm update -g amxx-builder    # обновить
npm rm -g amxx-builder        # удалить
```

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

Конкретная версия (тэг, ветка, коммит):

```bash
# По умолчанию — последний релиз
curl -fsSL https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/install.sh | bash

# Конкретная версия
AMXB_VERSION=v1.2.3 curl -fsSL https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/install.sh | bash
```

```powershell
# По умолчанию — последний релиз
irm https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/install.ps1 | iex

# Конкретная версия
$env:AMXB_VERSION="v1.2.3"; irm https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/install.ps1 | iex
```

Требования: **Node.js 18+**. git не требуется для установки и сборки — нужен только если манифест использует `github.ssh: true` (приватные репозитории по SSH-ключам).

**Visual Studio Code**

Расширение для VSCode - [AMXB — AMX Mod X Builder](https://marketplace.visualstudio.com/items?itemName=amxx-modular-ecosystem.amxb-vscode).

Команда `amxb init --vscode` создаёт `.vscode/extensions.json` с рекомендациями расширений
для AMXX-проекта (`Faktor.amxx-pawn-all-in` + `amxx-modular-ecosystem.amxb-vscode`).
Существующий файл не перезаписывается: рекомендации проекта сохраняются, недостающие
добавляются.

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
amxb init --script                  # + создать build.bat / build.sh для быстрого запуска amxb build
amxb init --opencode                # + создать .opencode/ (opencode.json с MCP-конфигом + мост скиллов)
amxb init --vscode                  # + создать .vscode/extensions.json с рекомендациями расширений (алиас: --vsc)
amxb init --force                   # перезаписать существующие файлы (по умолчанию пропускаются)
amxb init --force --with-manifest   # + перезаписать и существующий amxbuild.yml (без --with-manifest манифест не трогается)

amxb clean                          # очистить build/ и кэш клонов
amxb clean --all                    # + кэш компилятора
amxb cache info                     # показать содержимое кэша

amxb opencode-skills                # пути к материализованным скиллам (bundled + проект + deps/repos) для моста opencode
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

## Управление плагинами и INI

Секция `plugins:` описывает, какие плагины попадают в INI-файлы, как эти файлы называются и добавлять ли к строке плагина ` debug`. Она состоит из двух частей:

- `defaults:` — базовый слой, применяется ко **всем** плагинам (локальным и из репо);
- `rules:` — glob-правила **только для локальных** `.sma` из `amxmodx/scripting/`; первое совпадение побеждает.

```yaml
plugins:
  defaults:
    ini: myserver        # базовый INI для всех плагинов → plugins-myserver.ini
    debug: false         # true → к каждой строке добавляется " debug"
  rules:
    - match: "VipM/*.sma"
      ini: vipm          # → plugins-vipm.ini (переопределяет defaults)
      debug: true        # vip_core.amxx debug
    - match: "utils/*.sma"
      ini: false         # компилировать, но не включать ни в один INI
    - match: "wip/*.sma"
      enabled: false     # полностью пропустить (не компилировать, не деплоить)
```

Плагины из репозитория настраиваются на самом репо:

```yaml
repos:
  - repo: Org/VipModular
    plugins:
      ini: vip           # → plugins-vip.ini
      debug: false
```

**Значения `ini`:**

| Значение | Результат |
| --- | --- |
| `false` | Скомпилировать, но не включать ни в один INI |
| `true` или `""` | Включить в `plugins.ini` |
| `"<postfix>"` | Включить в `plugins-<postfix>.ini` |
| не задано | Наследуется у более низкого слоя приоритета |

**Поля:**

| Поле | Где | По умолчанию | Описание |
| --- | --- | --- | --- |
| `defaults.ini` | `plugins` | — | Базовый INI для всех плагинов |
| `defaults.debug` | `plugins` | `false` | `true` — к строке плагина добавляется ` debug` |
| `rules[].match` | `plugins` | — | Glob-паттерн относительно `scripting/` |
| `rules[].enabled` | `plugins` | `true` | `false` — пропустить компиляцию и деплой |
| `rules[].ini` | `plugins` | `defaults.ini` | Значение `ini` для совпавших локальных плагинов |
| `rules[].debug` | `plugins` | `defaults.debug` | `debug` для совпавших локальных плагинов |
| `repos[].plugins.ini` | репо | `defaults.ini` | Значение `ini` для плагинов этого репо |
| `repos[].plugins.debug` | репо | `defaults.debug` | `debug` для плагинов этого репо |

**Приоритет:** `plugins.rules` → `repos[].plugins` → `plugins.defaults` → выключено (без INI). Правила `rules` действуют только на локальные плагины; `defaults` и `repos[].plugins` — на все.

Генерация INI включается сама, как только любое эффективное значение `ini` не `false` (задано в `defaults`, в правиле или на репо). Если `defaults.ini` при этом не задан, а INI включён только правилом или репо, все остальные плагины попадают в `plugins.ini`. Если `ini` не задано нигде — INI-файлы не создаются.

Старая форма `plugins:` — массив правил без `defaults` — ещё принимается. Поля `output.generate_ini`, верхнеуровневый `plugins_ini_postfix` и `repos[].plugins_ini_postfix` устарели: они продолжают работать, но при сборке пишут предупреждение. Используйте вместо них `plugins.defaults.ini` и `repos[].plugins`.

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
  assets_path: ""                  # default: "" = корень deploy.path (assets/models, assets/sound → models/, sound/)
                                   # Задайте, например, "{name}", чтобы зеркалировать layout архива
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

> **Деплой аддитивен.** `amxb deploy` только копирует файлы из `build/` в `deploy.path` и
> никогда не удаляет на сервере то, чего нет в источнике — на сервере могут жить и другие
> плагины/файлы, не управляемые этим манифестом. Удаление с сервера происходит только в
> watch-режиме для файлов, удалённых локально во время слежения. Если нужно «вычистить»
> осиротевшие файлы (например, после переименования плагина) — удалите их вручную или
> очистите каталог перед `amxb deploy`.

`amxb watch` отслеживает изменения в `amxmodx/` и `assets/`:

- `.sma` → пересобрать плагин, задеплоить `.amxx`, послать RCON
- `.inc` → пересобрать только плагины, зависящие от этого инклюда (по `#include`/`#tryinclude`)
- остальные файлы → задеплоить напрямую
- манифест → полная пересборка

## Несколько GitHub токенов

Если репозитории, зависимости или release-ассеты разнесены по разным организациям, а один fine-grained PAT не может охватывать несколько организаций — укажи мапу `github.tokens` (владелец → имя env-переменной с токеном этой организации):

```env
# .env рядом с amxbuild.yml
GITHUB_TOKEN=ghp_fallback_xxx          # fallback для всех остальных
GITHUB_TOKEN_ORGA=github_pat_111_...
GITHUB_TOKEN_ORGB=github_pat_222_...
```

```yaml
github:
  token_env: GITHUB_TOKEN          # необязательно, по умолчанию GITHUB_TOKEN
  tokens:                          # необязательно — owner → env-переменная
    AmxxModularEcosystem: GITHUB_TOKEN_ORGA
    Next21Team:            GITHUB_TOKEN_ORGB
```

Резолвер для каждого `owner/repo`:

1. `github.tokens[owner]` — токен организации (если owner есть в мапе);
2. `github.token_env` (по умолчанию `GITHUB_TOKEN`) — глобальный токен;
3. иначе — анонимный доступ (публичные репо).

Мапа применяется ко всему: репозитории из `repos:`, зависимости (`deps`/`DEPS_LIST`/`deps_override`), GitHub release-ассеты в `assets.sources` и команда `amxb deps-tree`. Для транзитивных зависимостей токен подбирается по владельцу автоматически.

## Локальные источники (repos/deps)

Запись в `repos:` или `deps:` можно взять не с GitHub, а из локальной папки. Содержимое читается как есть, как соседние `amxmodx/` и `assets/`: локальный репозиторий собирается вместе с проектом (его `.sma` компилируются), а локальная зависимость отдаёт свои `.inc` в `build/_includes/`.

**Локальный репозиторий** (полноценная часть сборки):

```yaml
repos:
  - source: local
    path: ../ProjectA          # относительно папки манифеста (или абсолютный)
    name: projecta             # необязательно; по умолчанию basename пути
    # также поддерживаются amxmodx_dir, plugins (ini/debug),
    # exclude, exclude_files, deps_override
    # устаревший plugins_ini_postfix ещё принимается (с предупреждением)
```

`path` обязателен, `name` необязателен. Внутренний id такой записи: `local/<name>`, по умолчанию `local/<basename пути>`. Поля `repo` и `ref` указывать нельзя. `DEPS_LIST` и `deps_override` локального репо продолжают работать.

**Локальная зависимость** (только `.inc` для компиляции):

```yaml
deps:
  - source: local
    path: ../Shared
    name: shared                       # необязательно
    include_path: scripting/include    # необязательно
```

`path` обязателен, `name` и `include_path` необязательны. Поля `repo`, `ref`, `id`, `url`, `asset` запрещены. Строковая форма `owner/repo@ref[:include_path]` остаётся только для git, локальный dep задаётся объектом.

Все интерфейсы видят локальные источники одинаково: `amxb build`, `--dry-run`, `deps-tree`, `watch`, serve (`build.plan`) и MCP (`build_plan`, `get_dep_tree`, `validate_manifest`).

### Интеграция проектов через AMXB_LOCAL_SOURCES

Чтобы собрать проект B против локального чекаута проекта A (без релиза), манифест править не нужно. Переменная `AMXB_LOCAL_SOURCES` перенаправляет **уже объявленную** запись (`repos` или `deps`) на локальную папку по её логическому id `owner/repo` (регистр не важен). Новые записи она не создаёт.

```bash
# один источник
AMXB_LOCAL_SOURCES='AmxxModularEcosystem/VipModular=../VipModular' amxb build

# несколько: через ; или перевод строки
AMXB_LOCAL_SOURCES=$'Org/A=../A\nOrg/B=/abs/B' amxb build

# JSON-объект (значение начинается с {)
AMXB_LOCAL_SOURCES='{"Org/A":"../A","Org/B":"/abs/B"}' amxb build
```

Пути считаются от папки манифеста (абсолютные тоже принимаются). Так как `.env` рядом с манифестом читается до разбора, редирект можно положить туда и держать в `.gitignore`.

**Приоритет источников:**

| Источник | Приоритет (↑ выше) |
| --- | --- |
| `AMXB_LOCAL_SOURCES` (env) | 1 |
| манифест, `source: local` | 2 |
| манифест, GitHub (`repo`/`ref`) | 3 |

`AMXB_LOCAL_STRICT=1` (или `true`) делает ошибкой id из env, для которого нет репо/dep в манифесте. Без него такой id просто пишет предупреждение и игнорируется. Каждый применённый редирект пишет предупреждение. Кривой синтаксис env тоже предупреждение, не фатальная ошибка.

### Ограничения локальных источников

- Локальные источники **не версионируются**: рабочее дерево читается как есть, поэтому сборка не воспроизводима. Это годится для разработки и интеграции, но не для релизов.
- `amxb watch` следит только за `amxmodx/` и `assets/` манифеста и **не** следит за папками локальных зависимостей: правки в локальном dep не запускают пересборку автоматически.
- Папка должна существовать: отсутствующий `path` или опечатка в нём дают жёсткую ошибку, если для этого id не задан редирект в `AMXB_LOCAL_SOURCES` (редирект имеет приоритет и может перекрыть устаревший `path`).
- Внутренний id локальной записи должен быть уникальным: если два источника дают одинаковый `local/<name>` (например, у папок совпал basename), сборка останавливается с ошибкой. Задайте разные `name`.

## GitHub Actions

```yaml
uses: AmxxModularEcosystem/amxx-builder@v1
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
    branches: [master, main, feature/**, fix/**]
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
      - uses: actions/checkout@v5

      - id: sha
        run: echo "SHORT=$(git rev-parse --short HEAD)" >> $GITHUB_OUTPUT

      - id: build
        uses: AmxxModularEcosystem/amxx-builder@v1
        with:
          set: |
            output.pack=false
            output.dir=./artifact

      - uses: actions/upload-artifact@v5
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
      - uses: actions/download-artifact@v5
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
        uses: AmxxModularEcosystem/amxx-builder@v1
        with:
          github-token: ${{ secrets.MY_PAT }}
```

Несколько организаций — передай секреты через `env:` и пропиши мапу через инпут `set`:

```yaml
      - id: build
        uses: AmxxModularEcosystem/amxx-builder@v1
        env:
          GITHUB_TOKEN_ORGA: ${{ secrets.TOKEN_ORGA }}
          GITHUB_TOKEN_ORGB: ${{ secrets.TOKEN_ORGB }}
        with:
          set: |
            github.tokens.AmxxModularEcosystem=GITHUB_TOKEN_ORGA
            github.tokens.Next21Team=GITHUB_TOKEN_ORGB
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

## deps: fungun.net

[fungun.net](https://fungun.net) — магазин закрытых AMXX-плагинов. Архивов и
GitHub-репозиториев у плагинов нет, но файлы `.inc` публично видны на странице
плагина без покупки. Указать такой инклюд как зависимость можно полной формой
записи `deps` через `source: fungun` — id плагина из ссылки магазина
(`.../?p=show&id=106` → `106`), либо сразу полную ссылку на страницу:

```yaml
deps:
  # id плагина из адреса страницы магазина
  - source: fungun
    id: 106

  # или полная ссылка на страницу плагина
  - source: fungun
    url: https://fungun.net/shop/?p=show&id=106
```

amxb открывает страницу, находит модалку с файлом `.inc` и кладёт его в
`build/_includes/`. Страница кэшируется в `<cache>/fungun/<id>/` на сутки: раз в
день кэш устаревает и перечитывается, чтобы подхватывать обновления `.inc` у
продавца (в отличие от git/release-кэшей, которые неизменяемы — у fungun нет
версии, которую можно запинить). `--no-fetch` использует кэш как есть, а если
очередное обновление страницы не удалось — сборка продолжается на прошлой
рабочей копии. Если на странице плагина нет `.inc` вовсе — сборка остановится
с понятной ошибкой.

## Полный пример

Все доступные опции: [`example/amxbuild.yml`](example/amxbuild.yml).

## MCP сервер

MCP сервер предоставляет агенту opencode информацию о публичном интерфейсе зависимостей AMX Mod X и стандартной библиотеки. Подробная документация — в [`docs/mcp/INDEX.md`](docs/mcp/INDEX.md).

Подключение в opencode:

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

Автоматически это настраивается командой `amxb init --opencode`: она создаёт
`.opencode/opencode.json` с этим MCP-конфигом и файл `.opencode/plugin/amxb-skills.js`,
тонкий мост, который при каждом старте opencode регистрирует скиллы из трёх источников:
собственные bundled-скиллы сборщика (`amxb skills-dir`), скиллы текущего проекта из его
`amxbuild.yml` (`skills:`) и скиллы всех `deps`/`repos`, прочитанные из их манифестов
(`amxb opencode-skills`; отсутствующие зависимости докачиваются из сети по требованию).
Абсолютных путей в `opencode.json` нет. Повторный запуск пропускает существующие файлы
(мержит конфиг), `--force` перезаписывает.

> Существующие файлы `.opencode/plugin/amxb-skills.js` автоматически не обновляются:
> чтобы получить версию с тремя источниками, пересоздайте плагин командой
> `amxb init --opencode --force` (или создайте файл заново).

**23 инструмента** — от просмотра `.inc` файлов до построения дерева зависимостей —
доступны через MCP. Каталог задокументированных инструментов (включая агент-доки и
скиллы) — в [`docs/mcp/INDEX.md`](docs/mcp/INDEX.md).

Агент-доки и скиллы теперь объявляются в самом манифесте: верхнеуровневые `docs:`
(справочная документация) и `skills:` (инструкции для агента). Они предназначены
**только агенту** — не попадают в `build/` и архив, и ничего не отдаётся по умолчанию,
пока автор не объявил запись явно. Пять инструментов обслуживают их: `get_dep_manifest`
возвращает сырой `amxbuild.yml` зависимости вместе со сводкой её `docs:`/`skills:`;
`list_agent_docs` / `get_agent_docs` и `list_agent_skills` / `get_agent_skills` читают
объявления как текущего проекта, так и зависимости (`dep`/`repo`). Содержимое,
полученное из зависимости, считается предоставленным её автором и непроверенным:
источник правды по API — `.inc` файлы. Подробнее — в
[`docs/mcp/INDEX.md`](docs/mcp/INDEX.md).

```yaml
docs:
  - file: docs/API.md            # путь внутри репо
    name: API                     # по умолчанию — имя файла без расширения
    description: Публичный API плагина
skills:
  - file: skills/config.md        # одиночный скилл-файл
    name: config
  - dir: skills/deep-config       # скилл-папка (SKILL.md + references)
    name: deep-config
```

## Скилл миграции для ИИ-агентов

Для проектов, которые ещё не используют amxb, есть готовый скилл **amxb-migration**:
он переводит репозиторий AMXX-плагинов на `amxbuild.yml`, подключает `deps`,
настраивает `.gitignore` / CI / MCP и заменяет старые скрипты сборки.

В проекте, созданном через `amxb init --opencode`, скиллы amxb (включая
`amxb-migration`) подхватываются opencode автоматически: мост-плагин
`.opencode/plugin/amxb-skills.js` при каждом старте регистрирует не только
bundled-скиллы сборщика, но и скиллы текущего проекта и его `deps`/`repos`.

Канонический файл скилла (можно подключать по прямой ссылке до установки самого amxb —
шаг 0 скилла ставит amxb при необходимости):

- `skills/amxb-migration/SKILL.md` в этом репозитории
- Прямая ссылка: <https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/skills/amxb-migration/SKILL.md>

### Использование без установки (по ссылке)

Установка нужна только для **авто-подхвата** скилла (агент сам находит его по
`description` в frontmatter) и для работы **без доступа в сеть**. Но скилл —
это просто самодостаточный markdown: агенту достаточно явно дать ссылку на
файл, и он сам прочитает инструкции и будет им следовать.

Пример промпта агенту (opencode, Claude Code и т.п.):

> Мигрируй проект на amxb. Прочитай и следуй: https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/skills/amxb-migration/SKILL.md

Условия работоспособности этого способа:

- у агента есть доступ в сеть (разрешён `webfetch` / `curl`); в песочнице
  без сети остаётся только установка или вставка текста файла в промпт;
- давать **raw-ссылку** (`raw.githubusercontent.com`), а не страницу
  репозитория — иначе агент получит HTML-обёртку GitHub;
- скилл надо явно упоминать в каждом запросе — авто-триггер по описанию
  работает только у установленного скилла;
- файл должен быть запушен в `master` (пока правки не в репозитории,
  ссылка вернёт 404).

Для разовой миграции достаточно ссылки. Для регулярного использования —
установите скилл один раз глобально, дальше он будет подхватываться сам.

### Установка в сторонний проект

**opencode** (в проект):

```bash
mkdir -p .opencode/skills/amxb-migration
curl -fsSL https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/skills/amxb-migration/SKILL.md \
  -o .opencode/skills/amxb-migration/SKILL.md
```

**opencode** (глобально, во все проекты):

```bash
mkdir -p ~/.config/opencode/skills/amxb-migration
curl -fsSL https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/skills/amxb-migration/SKILL.md \
  -o ~/.config/opencode/skills/amxb-migration/SKILL.md
```

**Claude Code** (в проект или глобально):

```bash
mkdir -p .claude/skills/amxb-migration      # или ~/.claude/skills/amxb-migration
curl -fsSL https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/skills/amxb-migration/SKILL.md \
  -o .claude/skills/amxb-migration/SKILL.md
```

После установки перезапустите агента, чтобы скилл подхватился. Скилл сам подскажет
установку amxb, если тот ещё не установлен в окружении.

## Приоритеты

| Что | Порядок (↑ выше) |
| --- | --- |
| плагины (`plugins.rules`) | правила применяются по порядку, первое совпадение побеждает |
| INI плагинов | `plugins.rules` → `repos[].plugins` → `plugins.defaults` → выключено |
| зависимости | `manifest.deps` → `deps_override` → `DEPS_LIST` файл в репо |
| локальные источники | `AMXB_LOCAL_SOURCES` (env) → манифест `source: local` → GitHub |
| ассеты | порядок в `sources:` + `on_conflict` |
| версия компилятора | `amxmodx.version` → последний релиз |
| значения манифеста | `--set` → манифест проекта → `defaults/amxbuild.defaults.yml` |

## Устранение неполадок

### `no such file or directory: ./amxxpc`

Если файл `./amxxpc` существует и имеет права на исполнение (`chmod +x amxxpc`), но вы всё равно получаете ошибку **"No such file or directory"** при его запуске, скорее всего, в вашей 64-битной системе Linux отсутствуют 32-битные библиотеки.
`amxxpc` — это 32-битный исполняемый файл, которому требуется поддержка 32-битной архитектуры (`i386`).

#### Решение: Установите поддержку 32-битной архитектуры

**Ubuntu / Debian / WSL:**

```bash
sudo dpkg --add-architecture i386
sudo apt update
sudo apt install libc6:i386 libstdc++6:i386
```

### Сборка падает на `/mnt/...` в WSL

`amxxpc` — 32-битный Linux-бинарник, но под WSL он **не читает** файлы на
Windows-дисках, смонтированных в `/mnt/*` (DrvFs/9p: `/mnt/c`, `/mnt/d`, `/mnt/j`, …).
Node/bash эти файлы видят, поэтому ошибка выглядит «мистической»:

- локальный `.sma` на `/mnt/*` → `fatal error 100: cannot read from file: ".../plugin.sma"`;
- локальная папка `include/` на `/mnt/*` (идёт как `-i`) → `std::bad_alloc` / `Aborted` (SIGABRT).

Плагины из `repos:` при этом собираются нормально — их исходники amxb кладёт в
нативный кэш `~/.cache/amxx-builder`. Запись `.amxx` на `/mnt/*`, наоборот, работает.

**Решение:** собирать из нативной Linux-файловой системы. Скопируйте проект в `~` —
кэш компилятора и зависимостей общий, заново ничего не скачивается:

```bash
mkdir -p ~/amxb-build && cp -r amxmodx assets amxbuild.yml ~/amxb-build/
cd ~/amxb-build && amxb build
```

Альтернативы: выполнять сборку на Windows (`build.bat` или `amxb build` в PowerShell)
либо в CI. Команды без запуска компилятора (`amxb validate`, `amxb deps-tree`,
`amxb build --dry-run`) под `/mnt/*` работают.

> `amxb build --build-dir <нативный путь>` **не** решает проблему: локальные `.sma`
> компилируются по месту, из папки проекта, а не из `build/`.
