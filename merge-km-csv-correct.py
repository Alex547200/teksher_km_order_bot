#!/usr/bin/env python3
"""Merge Teksher KM CSV files into one validated CSV."""

from __future__ import annotations

import argparse
import csv
import io
import os
import sys
import zipfile
from collections import Counter
from datetime import datetime
from pathlib import Path


DEFAULT_INPUT_DIR = Path("/Users/admin/Desktop/Текшер CSV/16.05.2026")
DEFAULT_OUTPUT_CSV = Path("/Users/admin/Desktop/Текшер CSV/16_05_2026_KM_CORRECT.csv")
DEFAULT_CHECK_TXT = Path("/Users/admin/Desktop/Текшер CSV/16_05_2026_KM_CHECK.txt")


def normalize_text(value: str) -> str:
    return str(value or "").replace("\u0000", "").strip()


def is_km_candidate(text: str) -> bool:
    value = normalize_text(text)
    if not value:
        return False
    if value.startswith("01") and len(value) >= 16:
        return True
    if "\x1d" in value:
        return True
    return False


def extract_km_text(row: list[str]) -> str:
    cells = [normalize_text(cell) for cell in row if normalize_text(cell)]
    if not cells:
        return ""
    return "".join(cells)


def iter_csv_files_from_dir(root: Path, exclude_names: set[str] | None = None) -> list[Path]:
    exclude_names = exclude_names or set()
    return sorted(
        [
            path
            for path in root.rglob("*.csv")
            if path.is_file()
            and path.name not in exclude_names
            and not path.name.endswith("_KM_CORRECT.csv")
        ],
        key=lambda item: item.as_posix(),
    )


def read_rows_from_csv_path(csv_path: Path) -> list[list[str]]:
    rows: list[list[str]] = []
    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle)
        for row in reader:
            if not row:
                continue
            rows.append([cell for cell in row])
    return rows


def read_rows_from_zip(zip_path: Path) -> tuple[list[tuple[str, list[list[str]]]], list[str]]:
    sources: list[tuple[str, list[list[str]]]] = []
    names: list[str] = []
    with zipfile.ZipFile(zip_path) as archive:
        for name in sorted(archive.namelist()):
            if not name.lower().endswith(".csv"):
                continue
            with archive.open(name, "r") as raw:
                text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
                reader = csv.reader(text)
                rows = [[cell for cell in row] for row in reader if row]
            sources.append((name, rows))
            names.append(name)
    return sources, names


def load_input_rows(source: Path) -> tuple[list[tuple[str, list[list[str]]]], str]:
    if source.is_dir():
        csv_files = iter_csv_files_from_dir(
            source,
            exclude_names={
                DEFAULT_OUTPUT_CSV.name,
                DEFAULT_CHECK_TXT.name,
            },
        )
        sources: list[tuple[str, list[list[str]]]] = []
        for csv_path in csv_files:
            sources.append((csv_path.as_posix(), read_rows_from_csv_path(csv_path)))
        return sources, source.as_posix()

    if source.is_file() and source.suffix.lower() == ".zip":
        sources, _ = read_rows_from_zip(source)
        return sources, source.as_posix()

    raise FileNotFoundError(f"Input path is not a directory or zip archive: {source}")


def merge_csv_rows(sources: list[tuple[str, list[list[str]]]]) -> tuple[list[list[str]], dict[str, object]]:
    merged_rows: list[list[str]] = []
    km_values: list[str] = []
    file_row_counts: list[dict[str, object]] = []
    total_rows = 0
    gs_rows = 0
    invalid_rows = 0

    for source_name, rows in sources:
        source_written = 0
        for row in rows:
            total_rows += 1
            km_text = extract_km_text(row)
            if not km_text:
                invalid_rows += 1
                continue
            if not is_km_candidate(km_text):
                invalid_rows += 1
                continue
            merged_rows.append(row)
            km_values.append(km_text)
            source_written += 1
            if "\x1d" in km_text:
                gs_rows += 1
        file_row_counts.append(
            {
                "source": source_name,
                "rows": len(rows),
                "kept": source_written,
            }
        )

    counts = Counter(km_values)
    duplicates = {km: count for km, count in counts.items() if count > 1}
    lengths = Counter(len(km) for km in km_values)
    stats = {
        "files": len(sources),
        "totalRows": total_rows,
        "kmRows": len(km_values),
        "uniqueKm": len(counts),
        "duplicateKm": sum(count - 1 for count in counts.values() if count > 1),
        "gsRows": gs_rows,
        "invalidRows": invalid_rows,
        "lengthHistogram": dict(sorted(lengths.items())),
        "duplicates": duplicates,
        "fileRowCounts": file_row_counts,
    }
    return merged_rows, stats


def write_outputs(rows: list[list[str]], stats: dict[str, object], output_csv: Path, output_check: Path, source: Path) -> None:
    output_csv.parent.mkdir(parents=True, exist_ok=True)

    with output_csv.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        for row in rows:
            writer.writerow(row)

    lines = [
        f"generatedAt: {datetime.now().isoformat()}",
        f"source: {source}",
        f"outputCsv: {output_csv}",
        f"files: {stats['files']}",
        f"totalRows: {stats['totalRows']}",
        f"kmRows: {stats['kmRows']}",
        f"uniqueKm: {stats['uniqueKm']}",
        f"duplicateKm: {stats['duplicateKm']}",
        f"gsRows: {stats['gsRows']}",
        f"invalidRows: {stats['invalidRows']}",
        f"lengthHistogram: {stats['lengthHistogram']}",
        "",
        "fileRowCounts:",
    ]

    for item in stats["fileRowCounts"]:  # type: ignore[index]
        lines.append(f"- {item['source']}: rows={item['rows']} kept={item['kept']}")

    lines.extend(["", "duplicates:"])
    duplicates = stats["duplicates"]  # type: ignore[index]
    if duplicates:
        for km, count in sorted(duplicates.items()):
            lines.append(f"- {km}: {count}")
    else:
        lines.append("- none")

    lines.append("")
    lines.append("checks:")
    if stats["kmRows"] == 0:
        lines.append("- no KM rows found")
    else:
        lines.append("- KM rows found")
        lines.append("- csv.reader/csv.writer used")
        lines.append("- pandas not used")
        lines.append("- GS separators preserved where present")

    output_check.write_text("\n".join(lines) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Merge Teksher KM CSV files into one validated CSV.")
    parser.add_argument(
        "source",
        nargs="?",
        default=str(DEFAULT_INPUT_DIR),
        help="Input folder with CSV files or a ZIP archive. Default: ~/Desktop/Текшер CSV/16.05.2026",
    )
    parser.add_argument(
        "--output-csv",
        default=str(DEFAULT_OUTPUT_CSV),
        help="Output CSV path. Default: ~/Desktop/Текшер CSV/16_05_2026_KM_CORRECT.csv",
    )
    parser.add_argument(
        "--output-check",
        default=str(DEFAULT_CHECK_TXT),
        help="Output check txt path. Default: ~/Desktop/Текшер CSV/16_05_2026_KM_CHECK.txt",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = Path(args.source).expanduser()
    output_csv = Path(args.output_csv).expanduser()
    output_check = Path(args.output_check).expanduser()

    sources, source_label = load_input_rows(source)
    rows, stats = merge_csv_rows(sources)
    write_outputs(rows, stats, output_csv, output_check, Path(source_label))

    print(f"input source: {source_label}")
    print(f"files: {stats['files']}")
    print(f"km rows: {stats['kmRows']}")
    print(f"unique km: {stats['uniqueKm']}")
    print(f"duplicates: {stats['duplicateKm']}")
    print(f"gs rows: {stats['gsRows']}")
    print(f"length histogram: {stats['lengthHistogram']}")
    print(f"output csv: {output_csv}")
    print(f"output check: {output_check}")
    return 0 if stats["kmRows"] > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
