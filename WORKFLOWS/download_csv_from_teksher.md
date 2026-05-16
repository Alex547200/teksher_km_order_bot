# Выгрузи csv из текшера

Команда:

```bash
npm run download-16may-km-csv-api
```

Скрипт:

```text
download-16may-km-csv-api.js
```

Что делает:

- использует `GET /facade/api/v1/operations/filter`;
- фильтрует операции `MARK_CODE_ORDER`;
- скачивает CSV через `GET /facade/api/v1/marking_codes/csv?operationId=...`;
- сохраняет CSV в `~/Desktop/Текшер CSV/16.05.2026`;
- пишет лог `download_16may_km_csv_api_log.json`.

Что нельзя:

- не использовать POST/PUT/PATCH/DELETE;
- не использовать UI datepicker;
- не трогать старые рабочие сценарии.
