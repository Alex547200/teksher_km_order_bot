# Scripts

# `teksher.js`

Назначение: единая CLI-точка входа для основных рабочих сценариев проекта.

Команды запуска:

```bash
node teksher.js create
node teksher.js status
node teksher.js export
node teksher.js help
```

Что можно делать:

- `create` - запускать уже готовый `order-km.js` workflow для создания КМ после явного подтверждения `YES`;
- `status` - запускать уже готовый `audit-today.js` read-only workflow проверки статусов;
- `export` - запускать уже готовый `export-2026-05-15.js` read-only workflow выгрузки CSV/PDF;
- `help` - показывать доступные команды.

Что нельзя делать:

- запускать `create` без подтверждения `YES`;
- подменять логику существующих скриптов в новой обёртке;
- запускать изменяющие запросы из `status` или `export`;
- создавать новый profile/session вместо `teksher-session-profile`.

Какие файлы создаёт:

- сам CLI-файл артефактов не пишет;
- все артефакты создаются уже существующими скриптами-исполнителями.

## `order-km.js`

Назначение: основной рабочий скрипт для создания КМ-операций и batch-обработки в Текшер.

Команда запуска:

```bash
npm run start
```

Что можно делать:

- создавать новые операции через `POST /facade/order/api/v1/operations/multi`;
- проверять статусы созданных операций через `GET /facade/api/v1/operations/{operationId}`;
- работать с batch-файлами `batch.txt` и `batches.txt`;
- сохранять диагностические JSON-ответы и скриншоты.

Что нельзя делать:

- запускать наугад, если в payload есть не те GTIN/количества;
- переиспользовать старые `operationId` для повторного создания;
- выполнять изменяющие запросы без явной задачи.

Какие файлы создаёт:

- `~/Desktop/заказ км/api_response.json`
- `~/Desktop/заказ км/api_status_check.json`
- `~/Desktop/заказ км/next_api_response.json`
- `~/Desktop/заказ км/next_api_status_check.json`
- `~/Desktop/заказ км/batch_*.json`
- `~/Desktop/заказ км/screenshots/*`
- `~/Desktop/заказ км/diagnose_batch_successes.json`

## `export-2026-05-15.js`

Назначение: read-only экспорт CSV/PDF по операциям за 2026-05-15.

Команда запуска:

```bash
node export-2026-05-15.js
```

Что можно делать:

- читать список операций через GET;
- пробовать endpoint-ы списка и логировать результаты;
- сохранять raw response и probe results;
- скачивать доступные CSV/PDF;
- сохранять файлы по GTIN.

Что нельзя делать:

- запускать POST/PUT/PATCH/DELETE;
- начинать экспорт без найденного непустого GET endpoint;
- перезаписывать уже существующие файлы;
- запускать workflow внутри Codex sandbox, если нужен реальный browser runtime.

Какие файлы создаёт:

- `~/Desktop/заказ км/электросталь печать кодов паркеровки/operations_raw.json`
- `~/Desktop/заказ км/электросталь печать кодов паркеровки/endpoint_probe_results.json`
- `~/Desktop/заказ км/электросталь печать кодов паркеровки/index.json`
- `~/Desktop/заказ км/электросталь печать кодов паркеровки/*.(csv|pdf)`
- `api_pdf_download_log.json`

## `km-status-check.js`

Назначение: локальная проверка статусов КИЗ по файлам из папки `~/Desktop/заказ км/битые`.

Команда запуска:

```bash
node km-status-check.js
```

Что можно делать:

- читать `marking_codes_7_fixed.txt`;
- сопоставлять GTIN, serial и статус из локальных JSON-артефактов;
- находить дубли GTIN;
- сохранять JSON и CSV результат.

Что нельзя делать:

- ходить в Текшер по сети;
- выполнять POST/PUT/PATCH/DELETE;
- менять состояние операций.

Какие файлы создаёт:

- `~/Desktop/заказ км/битые/km_status_check.json`
- `~/Desktop/заказ км/битые/km_status_check.csv`
