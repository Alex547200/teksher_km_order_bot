# Teksher KM Order Bot

Проект для автоматизации работы с Текшер КМ: создание операций маркировки, проверка статусов КИЗ и выгрузка CSV/PDF по GTIN.

## Подход

Основной рабочий путь теперь - API вместо UI. Playwright и браузер используются только там, где без них нельзя обойтись, но не как базовый механизм.

## Где лежат результаты

Основные артефакты пишутся в:

```text
~/Desktop/заказ км
```

Типовые подкаталоги и файлы:

```text
~/Desktop/заказ км/screenshots
~/Desktop/заказ км/битые
~/Desktop/электросталь печать кодов паркеровки
```

Там же появляются JSON-логи, CSV, index-файлы, диагностические ответы и ошибки.

## Важные скрипты

- `teksher.js` - единая CLI-точка входа: `create`, `status`, `export`, `help`.
- `order-km.js` - создание операций КМ и batch workflow.
- `export-2026-05-15.js` - read-only выгрузка CSV/PDF по операциям за 2026-05-15 через GET/download.
- `km-status-check.js` - локальная проверка статусов КИЗ из файлов.
- `create-km-from-excel.js` - dry-run/commit batch workflow создания КМ из Excel `коледино выгрузка.xlsx`.

Подробности по каждому скрипту зафиксированы в [SCRIPTS.md](SCRIPTS.md).

## Запуск

Обычно запуск делается из обычного Terminal в корне проекта:

```bash
cd ~/AI_PROJECTS/teksher_km_order_bot
npm run start
```

Для export/status-check есть отдельные npm-команды, описанные в `package.json` и `SCRIPTS.md`.

## Unified CLI

Единая команда для основных сценариев:

```bash
node teksher.js help
node teksher.js create
node teksher.js status
node teksher.js export
```

`create` перед запуском показывает GTIN из `batch.txt` и требует подтверждение `YES`.

## Export details

Экспорт 2026-05-15 использует GET list endpoint-ы операций, затем GET/download по `operationId`.

Основные артефакты экспорта:

```text
~/Desktop/заказ км/электросталь печать кодов паркеровки
```

Файлы PDF/CSV именуются по GTIN, при дубле получают суффикс `_1`, `_2` и т.д.
