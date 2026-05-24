# amxx-builder

CLI-инструмент для сборки AMX Mod X серверов. Читает `manifest.yml`, клонирует плагины с GitHub, компилирует `.sma → .amxx` и упаковывает всё в готовый `.zip`.

## Установка

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/main/install.ps1 | iex
```

**Linux / macOS**:

```bash
curl -fsSL https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/main/install.sh | bash
```

Для приватных репозиториев передайте GitHub PAT:

```powershell
$env:GITHUB_TOKEN="ghp_xxx"; irm .../install.ps1 | iex
```

Требования: **Node.js 16+**, **git**.

## Использование

```bash
amxb build                          # manifest.yml в текущей папке
amxb build --manifest path/to.yml   # явный путь
amxb build --dry-run                # показать план без выполнения
amxb build --no-fetch               # использовать кэш, без клонирования
amxb build --no-archive             # только скомпилировать, без .zip
amxb clean                          # очистить build/ и кэш клонов
amxb clean --all                    # + кэш компилятора
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
- упаковывает в `addons/amxmodx/` внутри архива

## Структура репо плагина

Инструмент ожидает папку `amxmodx/` в корне каждого репо:

```text
amxmodx/
  scripting/
    my_plugin.sma        ← компилируется в plugins/my_plugin.amxx
    include/             ← используется компилятором
  configs/
    my_plugin.cfg        ← копируется как есть
  lang/
    my_plugin.txt        ← копируется как есть
```

Имя папки переопределяется через `amxmodx.dir` (глобально) или `amxmodx_dir` (на репо).

## Локальные файлы

Рядом с `manifest.yml` можно положить:

```text
my-server/
  manifest.yml
  amxmodx/               ← мержится в addons/amxmodx/ (конфиги, доп. файлы)
    configs/
      server.cfg
  assets/                ← кладётся в корень архива
    models/
      weapon.mdl
    sound/
      weapon.wav
```

## GitHub Actions

```yaml
# .github/workflows/build.yml
name: Build

on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: AmxxModularEcosystem/amxx-builder@v1
        with:
          manifest: ./manifest.yml
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

Для приватных зависимостей передай PAT вместо встроенного токена:

```yaml
      - uses: AmxxModularEcosystem/amxx-builder@v1
        with:
          github-token: ${{ secrets.MY_PAT }}
```

Все доступные инпуты:

| Инпут | По умолчанию | Описание |
| --- | --- | --- |
| `manifest` | `./manifest.yml` | Путь к манифесту |
| `build-dir` | `./build` | Директория сборки |
| `no-fetch` | `false` | Пропустить клонирование (использовать кэш раннера) |
| `no-archive` | `false` | Только компиляция, без `.zip` |
| `github-token` | `${{ github.token }}` | GitHub токен для приватных репо |

Готовый архив появляется в `output.dir` манифеста (по умолчанию `./dist`). Добавь шаг `actions/upload-artifact`, чтобы сохранить его:

```yaml
      - uses: actions/upload-artifact@v4
        with:
          name: server-build
          path: dist/*.zip
```

## Локальная сборка (замена build.bat)

`repos:` не обязателен. Если не указан — инструмент работает только с локальными файлами.
Чтобы архив начинался с имени пакета (как при дистрибуции плагина), используй шаблон `{name}` в путях:

```yaml
name: VipModular
version: "5.0.0"

output:
  amxmodx_path: "{name}/addons/amxmodx"
  assets_path:  "{name}"
  readme: true
```

Результат:

```text
VipModular-5.0.0.zip
  VipModular/
    addons/amxmodx/
      plugins/vip_core.amxx
      configs/...
      lang/...
    models/...
  README.md
```

Полный пример: [`example/manifest.local.yml`](example/manifest.local.yml).

## ref: latest

```yaml
repos:
  - repo: AmxxModularEcosystem/VipModular
    ref: latest   # автоматически берёт тег последнего GitHub release
```

## Полный пример

Все доступные опции: [`example/manifest.yml`](example/manifest.yml).

## Приоритеты

| Что | Приоритет (↑ выше) |
|---|---|
| `plugins_ini_postfix` | плагин → репо → манифест |
| зависимости | `manifest.deps` → `deps_override` → `DEPS_LIST` файл в репо |
| версия компилятора | `amxmodx.version` → последний релиз |
