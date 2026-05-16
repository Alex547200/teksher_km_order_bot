# Changelog

## 2026-05

- Перешли от UI automation к API-first подходу для большинства задач Текшер КМ.
- Добавили batch workflow для создания операций и последующей проверки статусов.
- Зафиксировали read-only status check по `operationId` через `GET /facade/api/v1/operations/{operationId}`.
- Настроили локальную проверку КИЗ из файлов без обращения к Текшер.
- Зафиксировали export/download workflow в `export-2026-05-15.js` как read-only сценарий на GET list/detail/download endpoints.
- Перевели CSV/PDF export на именование файлов по GTIN и суффиксы `_1`, `_2` для дублей.
- Зафиксировали артефакты экспорта: `operations_raw.json`, `endpoint_probe_results.json`, `index.json`, `endpoint_health_check.json`, `token_diagnostic.json`.
- Добавили диагностику endpoint-ов, raw response logging и health check для экспорта.
- Зафиксировали, что Codex sandbox не подходит для реального export/download runtime, и такие задачи нужно запускать из обычного Terminal.

- Added a new 2026-05-16 CSV export workflow that names files by operation label, excludes 2026-05-15, and validates the final folder against an exact 81-file / 9-duplicate target.
