# `list_dep_incs`

Показывает только список `.inc` файлов зависимости без их содержимого. Быстрее `get_dep_interface` — подходит, когда нужно просто проверить, есть ли файл.

## Параметры

| Поле | Тип | Обязательный | Описание |
|------|-----|:---:|---------|
| `dep` | `string` | ✓ | Зависимость в формате `owner/repo@ref` |
| `source` | `"git" \| "release"` | — | Откуда скачать. По умолчанию `"git"` |
| `include_path` | `string` | — | Явный путь к папке с `.inc` файлами |
| `asset` | `string \| number` | — | Для `source: release` — какой ассет скачать |
| `token` | `string` | — | GitHub PAT |
| `no_fetch` | `boolean` | — | Не ходить в сеть, только кэш |

## Примеры

```
— Какие .inc файлы есть в AmxxModularEcosystem/ParamsController@1.4.0?
— Что лежит в includes у rehlds/ReAPI?
```
