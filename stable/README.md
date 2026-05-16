# Stable Teksher Workflow

## Что делает
- берёт ACCEPTED операции;
- выбирает нужный batch;
- скачивает CSV;
- сохраняет:
  81 CSV
  9 файлов _2

## Запуск

cd ~/AI_PROJECTS/teksher_km_order_bot

npm run download-all-16may

## Проверка

find ~/Desktop/"123 электросталь 2026-05-16" -name "*.csv" | wc -l

find ~/Desktop/"123 электросталь 2026-05-16" -name "*_2.csv" | wc -l

Ожидается:
81
9

## Важно
- не использовать GTIN из DataMatrix;
- mapping идёт по operationId/order;
- whitelist обязателен;
- output folder очищается перед запуском.
