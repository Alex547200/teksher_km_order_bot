# Changelog

## 2026-05

- Перешли от UI automation к API-first подходу для большинства задач Текшер КМ.
- Добавили batch workflow для создания операций и последующей проверки статусов.
- Зафиксировали read-only status check по `operationId` через `GET /facade/api/v1/operations/{operationId}`.
- Настроили локальную проверку КИЗ из файлов без обращения к Текшер.
- Перевели CSV/PDF export на именование файлов по GTIN.
- Добавили диагностику endpoint-ов и raw response logging для экспорта.
- Зафиксировали, что Codex sandbox не подходит для реального export/download runtime, и такие задачи нужно запускать из обычного Terminal.
