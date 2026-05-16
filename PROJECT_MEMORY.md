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

Рабочий экспортный скрипт для даты 2026-05-15:

```text
export-2026-05-15.js
```

Команда запуска:

```bash
node export-2026-05-15.js
```

Подход:

- только GET/download;
- без POST/PUT/PATCH/DELETE;
- использует авторизованную Playwright session `./teksher-session-profile`;
- сначала пробует list endpoint-ы операций, потом скачивает CSV/PDF по найденным `operationId`.

Endpoint-цепочка экспорта:

```text
GET /facade/api/v1/operations?page=0&size=100
GET /facade/order/api/v1/operations?page=0&size=100
GET /facade/order/api/v1/operations?createdFrom=2026-05-15&createdTo=2026-05-16
GET /facade/api/v1/operations?createdFrom=2026-05-15&createdTo=2026-05-16
GET /facade/api/v1/operations/{operationId}
GET /facade/order/api/v1/operations/{operationId}
GET /facade/api/v1/operations/{operationId}/print
GET /facade/order/api/v1/operations/{operationId}/print
GET /facade/api/v1/operations/{operationId}/download
GET /facade/order/api/v1/operations/{operationId}/download
GET /facade/api/v1/operations/{operationId}/pdf
GET /facade/order/api/v1/operations/{operationId}/pdf
GET /facade/api/v1/operations/{operationId}/csv
GET /facade/order/api/v1/operations/{operationId}/csv
```

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

Артефакты экспорта пишутся в:

```text
~/Desktop/заказ км/электросталь печать кодов паркеровки
```

## Excel batch create workflow

Источник batch-данных:

```text
~/Desktop/коледино выгрузка.xlsx
```

Правила:

- `Лист1`;
- столбец `A` - GTIN;
- столбец `B` - количество КМ;
- товарная группа - `Предметы одежды`;
- batch size - 10 строк;
- dry-run по умолчанию;
- реальный `POST /facade/order/api/v1/operations/multi` только с `--commit`;
- payload должен оставаться совместимым с уже рабочим API workflow:

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

## Безопасные правила

- не запускать изменяющие запросы без явной команды;
- не переиспользовать старые `operationId` для повторного создания;
- не запускать export/workflow внутри Codex sandbox, если нужен реальный browser runtime;
- предпочитать API-read-only там, где это возможно;
- сохранять все результаты в локальные артефакты проекта и Desktop output folders.
