# `list_dep_incs`

Показывает только список `.inc` файлов зависимости без их содержимого. Быстрее `get_dep_interface` — подходит, когда нужно просто проверить, есть ли файл.

## Режимы ввода

Режимы — **взаимоисключающие, а не аддитивные**: передайте один из вариантов.

1. `dep` — строка `owner/repo@ref` (или `owner/repo@ref:путь_до_include`).
2. Явные поля — `repo` (+ необязательный `ref`) вместе с `source` / `include_path` / `asset` / `ref_ttl`.
3. Полный объект зависимости прямо в аргументах (arg-bag): `source: "local"` + `path` или `source: "fungun"` + `id` / `url`.

Указать `dep` **вместе** с `source` / `include_path` / `asset` — ошибка `-32602` (invalid params), а не переопределение. Ошибки разбора/валидации зависимости тоже возвращаются как `-32602`.

## Параметры

| Поле | Тип | Обязательный | Описание |
|------|-----|:---:|---------|
| `dep` | `string` | — | Зависимость в формате `owner/repo@ref` или `owner/repo@ref:путь_до_include`. Альтернатива явным полям ниже (нужен один из режимов; см. «Режимы ввода») |
| `repo` | `string` | — | Альтернатива `dep`: `owner/repo` (нужен один из `dep`/`repo`; `ref` необязателен — default branch, для `release` — `latest`) |
| `ref` | `string` | — | Ref (тег/ветка/коммит) при использовании `repo`; по умолчанию default branch |
| `source` | `"git" \| "release" \| "local" \| "fungun"` | — | С `repo`: `"git"` (по умолчанию) или `"release"`. В arg-bag: `"local"` (с `path`) или `"fungun"` (с `id`/`url`). Не комбинируется с `dep` |
| `include_path` | `string` | — | Режим явных полей (альтернатива `dep`): явный путь к папке с `.inc` файлами |
| `asset` | `string \| number` | — | Режим явных полей (альтернатива `dep`): для `source: release` — какой ассет скачать |
| `ref_ttl` | `string \| number` | — | Режим явных полей (в `dep`-режиме не применяется): TTL кэша резолва `ref → SHA` для git — `"never"`, `30m`/`1h`/`7d` или целое число секунд |
| `path` | `string` | — | Arg-bag `source: "local"`: папка с `.inc` файлами (относительно манифеста/cwd или абсолютная) |
| `id` | `string \| number` | — | Arg-bag `source: "fungun"`: id плагина из ссылки магазина (например, `106`). Альтернатива `url` |
| `url` | `string` | — | Arg-bag `source: "fungun"`: полная ссылка на страницу плагина вместо `id` |
| `token` | `string` | — | GitHub PAT |
| `no_fetch` | `boolean` | — | Не ходить в сеть, только кэш |

## Примеры

```
— Какие .inc файлы есть в AmxxModularEcosystem/ParamsController@1.4.0?
— Что лежит в includes у rehlds/ReAPI?
— Какие .inc файлы есть в локальной зависимости из папки ../Shared?
```
