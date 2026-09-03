# `list_dep_docs`

Показывает список доступных доков зависимости без чтения их содержимого. Отмечает, какие файлы объявлены через `docs:` в манифесте (declared), какие найдены по конвенции (`docs/API.md`, `API.md` в корне репо), и подсвечивает объявленные, но отсутствующие пути.

## Параметры

| Поле | Тип | Обязательный | Описание |
|------|-----|:---:|---------|
| `dep` | `string` | — | Зависимость в формате `owner/repo@ref` или `owner/repo@ref:путь_до_include` |
| `repo` / `ref` / `source` / `include_path` / `asset` | — | — | Альтернатива `dep`: указать репозиторий и опции напрямую (как в `read_repo_file`) |
| `token` | `string` | — | GitHub PAT. Если не указан, берётся из `GITHUB_TOKEN` |
| `no_fetch` | `boolean` | — | Не ходить в сеть, только кэш |

## Примеры

```
— Какие доки есть у rehlds/ReAPI?
— Есть ли у AmxxModularEcosystem/ParamsController файл docs/API.md?
— Что объявлено в docs у AmxxModularEcosystem/VipModular@5.0.0-rc4f1?
```
