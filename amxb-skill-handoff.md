# AMXB skill handoff — ExtendedStats

**Дата:** 2026-10-19
**Контекст:** сплошной аудит проекта ExtendedStats и серия правок по требованиям владельца
(багфиксы, кодстайл, архитектура, DefaultObjects, API, инклюды, комментарии).
**Скиллы:**
- `amxx-pawn-style` (стиль; далее — **Style**) — `/mnt/c/Users/arkan/Desktop/amxmdox-server-builder/skills/amxx-pawn-style`
- `amxx-plugin-architecture` (архитектура; далее — **Arch**) — `/mnt/c/Users/arkan/Desktop/amxmdox-server-builder/skills/amxx-plugin-architecture`

Цель документа: зафиксировать (1) требования владельца, которых в скиллах **нет вообще**,
(2) правила, которые в скиллах **есть**, но были проигнорированы/применены частично, и
(3) прочие замечания к скиллам и проектным конвенциям.

---

## 1. Требования владельца, которых в скиллах нет в принципе

### 1.1. Явные `#include` в каждом `.inc` — и публичные, и локальные
**Требование:** каждый `.inc` сразу после include-guard подключает всё, что использует:
`<...>` (stdlib/зависимости) и `"..."` (локальные файлы плагина). Не полагаться на порядок
подключения в `.sma`.

**Почему это пробел:**
- Style прямо пишет: «Not yet covered: `#include` ordering» (`SKILL.md`, раздел «Not yet
  covered»). То есть тема объявлена неохваченной.
- Arch `references/module-layout.md` описывает только раскладку папок и путь в `#include`
  (стр. 14–32), но не правило «файл подключает свои зависимости».
- Проектный `docs/conventions/amxx-plugin-architecture.md` §5 говорит только о порядке
  `#include` в `.sma`, а не о самодостаточности каждого `.inc`.

**Куда добавить:** Arch → `references/module-layout.md` (новый раздел «Explicit includes»)
или Style → отдельный reference (`references/includes.md`), т.к. это ближе к «shared
includes». Там же — правило про вынос общей модели в отдельный `.inc` для разрыва цикла
(в проекте: `Core/EventModel.inc`, `ExtendedStatsXp/Core/Units.inc`).

### 1.2. Полезность комментариев: «почему», а не пересказ кода
**Требование:** комментарий должен объяснять причину/контракт/edge-case; комментарии,
пересказывающие имя функции или видимый код (`// Регистрирует ключ …`, `// {p:exs-level}`,
`// Возвращает число грейдов`), не нужны.

**Почему это пробел:** Style §14 говорит только о **section/banner**-комментариях
(«discouraged, not forbidden»). Общего правила «comment explains why, not what» в скилле нет.

**Куда добавить:** Style `SKILL.md` — новый пункт в Core rules + чек-лист.

### 1.3. Никакого центрального `State.inc`: объявления — в файле-владельце
**Требование:** переменные/константы объявляются там, где нужны (в модуле-владельце), а не
сваливаются в один `Core/State.inc`.

**Почему это пробел:** Arch говорит «one file per concern» и «store handles `static`», но
явного запрета на централизованный state-файл и явного требования «объявляй в
файле-владельце» нет. (После правок `State.inc` удалены; объявления разнесены по
`Core/Config.inc`, `Objects/Registry.inc`, `Core/Forward.inc`, `DefaultObjects/...`.)

**Куда добавить:** Arch → `references/module-layout.md` или `references/initialization.md`
(раздел «Where state lives»).

### 1.4. Граница «тонкого» DefaultObject
**Требование:** `DefaultObjects/<Kind>/<Name>.inc` — **только** реализация одного конкретного
объекта (его колбэки + `_Register`). Парсинг конфига, lookup-таблицы, дефолты и прочая
механика — в `Core/`, не в DefaultObject.

**Почему это пробел:** Arch `references/default-objects.md` требует «one object per file» и
функцию `_Register`, но **не формулирует границу тонкости**. Из-за этого «жирный» Stats-объект
(конфиг + таблица дефолтов + lookup + валидация + колбэк в одном файле) формально не нарушал
букву скилла.

**Куда добавить:** Arch `references/default-objects.md` — раздел «Thin object boundary»
(+ пример: config/lookup → `Core/Placeholders.inc`, объект → `DefaultObjects/.../Stats.inc`).

### 1.5. `callfunc` — крайний случай; для зарегистрированных колбэков — one-forward
**Требование:** не вызывать зарегистрированные колбэки через `get_func_id` + `callfunc`;
использовать `CreateOneForward`/`ExecuteForward` (one-forward).

**Почему это пробел:** Arch использует `CreateOneForward` в примерах (`forward-subscriptions`,
`default-objects`), но **нигде не формулирует предпочтение** one-forward над `callfunc` и не
объясняет, когда `callfunc` допустим. Style тему не касается.

**Куда добавить:** Arch `references/forward-subscriptions.md` — раздел «Calling a registered
callback: one-forward, not callfunc» (плюс DestroyForward при повторной регистрации).

---

## 2. Описано в скиллах, но было проигнорировано или применено частично

| # | Правило | Где описано | Что было | Статус |
|---|---|---|---|---|
| 2.1 | `Arg_*`-enum для аргументов нативов | Style `SKILL.md` rule 9; `references/natives.md` стр. 211 | обработчики индексировали литералами | **исправлено** (после замечания владельца) |
| 2.2 | Неиспользуемые `(pluginIndex, paramsCount)` — опускать | Style `references/natives.md` стр. 42–44, 212–213 | почти все обработчики объявляют пару, хотя не используют | **осталось** |
| 2.3 | `const` на каждом неизменяемом параметре | Style `SKILL.md` rule 6 | применено частично (в основном out-длины) | **частично** |
| 2.4 | `new const` вместо `#define` для констант | Style `SKILL.md` rule 4 | многие длины остались `#define`; скаляры — `const` | **частично / владелец пересмотрит** |
| 2.5 | Не «глушить» тег через `_:` | Style `SKILL.md` (must-not); `references/natives.md` стр. 137–153, 218–219 | остались `_:` для Float-in-Trie и enum-сравнений (с комментариями) | **частично / нужен carve-out** |
| 2.6 | Имена обработчиков `@On*` / `@Cmd*` / `@NativeName` | Style `SKILL.md` rule 9 | EventBus-обработчики — `public OnXpKill`, команды — `public Cmd_*` | **осталось / конфликт с проектом** |
| 2.7 | DefaultObjects: один объект — один файл; имя `DefaultObjects_<Type>_<Name>_Register` | Arch `references/default-objects.md` стр. 14–24, 113–122; `SKILL.md` (reserved names) | сначала все плейсхолдеры в одном файле, функции `ProgPh_Register*` | **исправлено** (после замечания) |
| 2.8 | Registrar подключает все объекты; `.sma` подключает только Registrar | Arch `references/default-objects.md` стр. 45–72, 116–120 | `.sma` подключал объекты напрямую | **исправлено** |
| 2.9 | Нативы регистрируются в `API/*.inc` (тонкая регистрация), а не в Core | Arch `references/api-layer.md` стр. 14–50, 101–103 | `IngestBroker_RegisterNatives`/`EventBus_RegisterNatives`/`ApiClientCore_RegisterNatives` жили в Core | **исправлено** (после замечания) |
| 2.10 | Идемпотентный init | Arch `references/initialization.md` стр. 13–36 | добавлены guard-флаги | **исправлено** (но см. 3.6) |
| 2.11 | Store handles (`Array`/`Trie`) — `static`, доступ через функции | Arch `references/objects-store.md` стр. 159–181, 196–197, 214 | после удаления `State.inc` — глобалы в файлах-владельцах, часть читается кросс-файлово | **осталось** |
| 2.12 | `_OnInited` + `_Init` + `PluginInit()` для API-реестров | Arch `references/initialization.md` стр. 37–102, 119–123 | не реализовано (XpCore/ProgressionCore имеют реестры) | **осталось** |
| 2.13 | Общие multi-forwards — через `.sma` (кроме registry-регистрации) | Arch `references/forward-subscriptions.md` стр. 17–60, 85–91, 105–110 | `ExS_Events_OnRegisterHandlers` объявлен в `DefaultObjects/Registrar.inc` | **осталось / конфликт с проектом** |
| 2.14 | `.sma` ничего не вызывает для регистрации объектов | Arch `references/default-objects.md` стр. 67–72, 119–120 | core-`.sma` вызывает `Placeholders_Init()` (страховка) | **мелкое отклонение** |

---

## 3. Прочие замечания

### 3.1. Противоречие между скиллами по `_:`
- Style (must-not) запрещает `_:`-касты, срезающие тег.
- Arch `references/objects-store.md` стр. 60–70 и 192–193 **требует** `_:` на struct-enum
  («Without it, the int-typed members trigger a tag mismatch»), а стр. 183–188 — не
  дублировать тег/struct, а включать общий `.inc`.

Нужен явный carve-out в Style: `_:` допустим (а) на объявлении struct-enum, (б) для
bit-punning `Float`↔cell в `Trie` (там нет Float-варианта), (в) при сравнении tagged-enum с
untagged-кодом — но не для сокрытия реального mismatch. Сейчас код именно так и поступает
(Float-in-Trie с комментариями), но формально нарушает Style.

### 3.2. Проектная конвенция расходилась со скиллом по имени регистратора
`docs/conventions/amxx-plugin-architecture.md` §7/§10 задавал `<Kind>_<Name>_Register()`, а
Arch `references/default-objects.md` — `DefaultObjects_<Type>_<Name>_Register()`. Документ
приведён к скиллу (+ исправлена опечатка `_RegsiterNatives`). Рекомендация: каноническое имя
держать в скилле, проектный док — ссылаться на него, чтобы не расходились.

### 3.3. EventBus-обработчики и `@`-именование
Style требует `@On*`, но EventBus подписывается **по строке**:
`ExS_Events_Subscribe("kill", "OnXpKill")` и резолвит `CreateOneForward(pluginId, handlerName)`.
Чтобы использовать `@OnKill`, строка подписки должна быть `"@OnKill"` — скилл этого не
оговаривает. Нужно явно описать: либо string-registered обработчики — исключение из `@On*`
(как AMXX-callback), либо разрешить `@`-имена в строках регистрации.

### 3.4. `forward-subscriptions.md` vs проектный Registrar
Arch говорит: общие multi-forwards — через `.sma`, исключение — только registry-регистрация.
Проектный `docs/conventions/amxx-plugin-architecture.md` §7 разрешает Registrar держать
«обработчики форвардов фреймворков», и код держит там `ExS_Events_OnRegisterHandlers`
(подписка на события — не registry-регистрация) и `PCPH_OnRegisterGroups` (registry —
исключение). Нужно решить: перенести `ExS_Events_OnRegisterHandlers` в `.sma` или явно
расширить исключение в Arch.

### 3.5. `new const` для скаляров
Style rule 4 формулирует «Compile-time constants use UPPER_SNAKE_CASE in a `new const`
declaration» без различия строк/массивов и скаляров. Владелец считает, что для одиночных
значений достаточно `const`, а `new const` — для строк/массивов, и планирует
пересмотреть скилл. Нужно уточнить правило (и, вероятно, разрешить `const` для скаляров).

### 3.6. Идемпотентный init: global-флаг vs `static bool` в функции
Arch `references/initialization.md` стр. 19–35 рекомендует `static bool:isInited` **внутри**
init-функции, «avoid polluting the global scope». В коде использованы глобальные флаги
(`BackendCoreBooted`, `ApiClientCoreBooted`, `IngestBrokerBooted`, `XpCoreStateBooted`).
Работает, но расходится с рекомендованной формой — стоит либо привести к `static`, либо
уточнить скилл, что глобальный флаг допустим для boot-состояния, которое читается извне.

### 3.7. Store handles `static` vs проект
Arch `objects-store.md` требует `static` для `Array`/`Trie` и доступ только через функции.
В проекте после удаления `State.inc` часть store-хендлов — глобалы в файлах-владельцах
(`StatsPhMetricTrie` читается из DefaultObject, `ProfileMetrics`/`SteamToIndex` — в
ApiClientCore и т.п.). Нужно либо сделать их `static` + аксессоры, либо зафиксировать
проектное исключение (один compilation unit, доступ через функции домена).

### 3.8. Динамические (config-driven) объекты vs «one object per file»
`default-objects.md` описывает «один конкретный объект на файл». Stats-плейсхолдеры —
**динамические** (набор ключей из `Placeholders.json`), поэтому «объект» там один —
generic-колбэк, а сами ключи приходят из конфига. Скиллу стоит явно сказать, что для
config-driven наборов DefaultObject — это один generic-объект, а парсинг/набор — в Core
(это ровно требование 1.4).

### 3.9. Include-порядок объявлен «not yet covered»
Style `SKILL.md` прямо перечисляет `#include` ordering как неохваченную тему. Требование 1.1
закрывает этот пробел — стоит перенести его из «not yet covered» в правила.

### 3.10. Наблюдение по процессу
Скиллы задают много «must do», но не дают «definition of done» для multi-file плагина в
виде одной проверочной последовательности (include self-sufficiency → API layer → DefaultObjects
→ static stores → idempotent init → `_OnInited`/`_Init`). Из-за этого правила применялись
частями и часть всплыла только по замечаниям владельца. Полезен единый чек-лист «готовности
плагина к ревью».
