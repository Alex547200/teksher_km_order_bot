#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_CSV="/Users/admin/Downloads/Telegram Desktop/новосемейкино_zip_KM_CORRECT.csv"
OUTPUT_DIR="/Users/admin/Desktop/novosemeykino_pdf"
OUTPUT_ZIP="/Users/admin/Desktop/novosemeykino_pdf.zip"
FALLBACK_PRODUCT_NAME="${FALLBACK_PRODUCT_NAME:-Новосемейкино}"

cd "$ROOT_DIR"

if [[ ! -f "$SOURCE_CSV" ]]; then
  echo "Missing source CSV: $SOURCE_CSV" >&2
  exit 2
fi

python3 rebuild_sonya_correct.py \
  --source-csv "$SOURCE_CSV" \
  --output-dir "$OUTPUT_DIR" \
  --zip-path "$OUTPUT_ZIP" \
  --allow-missing-workbook \
  --fallback-product-name "$FALLBACK_PRODUCT_NAME"

npm run merge-pdfs-by-product -- --source "$OUTPUT_ZIP"
