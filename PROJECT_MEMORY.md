# Project Memory

## Рабочий endpoint создания КМ

Основной рабочий endpoint:

```text
POST /facade/order/api/v1/operations/multi
```

Базовый payload:

```json
{
  "countryId": 199,
  "extension": "lp",
  "items": [
    {
      "gtin": "04707197100945",
      "markingCodesAmount": 5,
      "dataSupplier": "AUTO"
    }
  ]
}
```

Правила:

- `POST` создаёт новые операции;
- запускать его случайно нельзя;
- старые `operationId` не трогать;
- для проверки результата использовать `GET /facade/api/v1/operations/{operationId}`.

## Playwright session profile

Текущий рабочий профиль для browser-based сценариев:

```text
./teksher-session-profile
```

Он используется там, где нужен уже авторизованный браузерный контекст.

## Экспорт CSV/PDF

При выгрузке CSV/PDF файлы должны сохраняться по GTIN.

Формат имени:

```text
04707197100785.csv
04707197100785.pdf
04707197100785_1.csv
```

Если GTIN неизвестен, fallback:

```text
operationId.csv
operationId.pdf
```

## Безопасные правила

- не запускать изменяющие запросы без явной команды;
- не переиспользовать старые `operationId` для повторного создания;
- не запускать export/workflow внутри Codex sandbox, если нужен реальный browser runtime;
- предпочитать API-read-only там, где это возможно;
- сохранять все результаты в локальные артефакты проекта и Desktop output folders.
