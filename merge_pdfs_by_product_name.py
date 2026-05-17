#!/usr/bin/env python3
"""Merge renamed Teksher PDFs by product name.

Inputs:
- a folder containing PDFs
- a ZIP archive containing PDFs

The script recursively searches for PDFs, groups files by product name prefix,
merges files in each group in deterministic order, and writes a merged PDF per
group using the form:

    <product name> -<pages_count>.pdf

The result folder contains the merged PDFs, a ZIP archive, and a text report.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import sys
import tempfile
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator


RUNTIME_PYTHON = Path(
    "/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3.12"
)


def reexec_if_needed() -> None:
    if Path(sys.executable).resolve() == RUNTIME_PYTHON:
        return
    if RUNTIME_PYTHON.exists():
        os.execv(str(RUNTIME_PYTHON), [str(RUNTIME_PYTHON), *sys.argv])


reexec_if_needed()

try:
    from PyPDF2 import PdfReader, PdfWriter  # type: ignore
except Exception:  # pragma: no cover
    from pypdf import PdfReader, PdfWriter  # type: ignore


DEFAULT_OUTPUT_DIR = Path("./merged_pdfs_by_product")
DEFAULT_ZIP_PATH = Path("./MERGED_PDFS_BY_PRODUCT_NAME_WITH_KM_COUNT.zip")
DEFAULT_REPORT_PATH = Path("./merge_by_product_report.txt")


@dataclass(slots=True)
class SourcePdf:
    group_name: str
    path: Path
    order_key: tuple[int, str]
    source_name: str
    pages: int = 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Merge renamed PDF labels by product name.")
    parser.add_argument("--source", required=True, help="Path to a ZIP archive or a folder containing PDFs.")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="Output folder for merged PDFs.")
    parser.add_argument("--zip-path", default=str(DEFAULT_ZIP_PATH), help="Output ZIP path.")
    parser.add_argument("--report-path", default=str(DEFAULT_REPORT_PATH), help="Text report path.")
    return parser.parse_args()


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def is_zip_path(path: Path) -> bool:
    return path.suffix.lower() == ".zip" or zipfile.is_zipfile(path)


def is_rar_path(path: Path) -> bool:
    return path.suffix.lower() == ".rar"


def safe_filename(name: str) -> str:
    text = str(name or "").replace("\x00", " ").replace("\r", " ").replace("\n", " ")
    text = re.sub(r'[\\/:*?"<>|]', "_", text)
    text = re.sub(r"\s+", " ", text).strip(" .")
    return text or "unnamed"


def is_pdf_file(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() == ".pdf"


def extract_archive_to_temp(source: Path) -> Path:
    temp_dir = Path(tempfile.mkdtemp(prefix="merge_pdfs_extract_"))
    if is_zip_path(source):
        with zipfile.ZipFile(source, "r") as archive:
            archive.extractall(temp_dir)
        return temp_dir

    if is_rar_path(source):
        raise ValueError("RAR is not supported for merge input. Please unpack it or provide a ZIP archive.")

    raise ValueError(f"Unsupported source type: {source}")


def iter_pdf_paths(source: Path) -> Iterator[Path]:
    if source.is_dir():
        for pdf in sorted(source.rglob("*")):
            if is_pdf_file(pdf):
                yield pdf
        return

    if is_zip_path(source):
        temp_dir = extract_archive_to_temp(source)
        try:
            for pdf in sorted(temp_dir.rglob("*")):
                if is_pdf_file(pdf):
                    yield pdf
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)
        return

    if is_rar_path(source):
        raise ValueError("RAR is not supported for merge input. Please unpack it or provide a ZIP archive.")

    raise ValueError(f"Unsupported source type: {source}")


def strip_group_suffix(stem: str) -> str:
    base = stem.strip()
    match = re.match(r"^(.*?)(?:([_-])(\d+))$", base)
    if not match:
        return base
    root, _, num = match.groups()
    if num in {"1", "2", "3"} and root.strip():
        return root.strip()
    return base


def sort_key_for_filename(path: Path) -> tuple[int, str]:
    stem = path.stem.strip()
    match = re.match(r"^(.*?)(?:([_-])(\d+))$", stem)
    if not match:
        return (0, stem.lower())
    root, sep, num = match.groups()
    if num.isdigit() and root.strip():
        return (int(num), root.lower())
    return (0, stem.lower())


def read_pdf_pages(pdf_path: Path) -> int:
    reader = PdfReader(str(pdf_path))
    return len(reader.pages)


def collect_sources(source: Path) -> list[SourcePdf]:
    items: list[SourcePdf] = []
    for pdf_path in iter_pdf_paths(source):
        group_name = strip_group_suffix(pdf_path.stem)
        items.append(
            SourcePdf(
                group_name=group_name,
                path=pdf_path,
                order_key=sort_key_for_filename(pdf_path),
                source_name=pdf_path.name,
            )
        )
    return items


def group_sources(items: list[SourcePdf]) -> dict[str, list[SourcePdf]]:
    grouped: dict[str, list[SourcePdf]] = defaultdict(list)
    for item in items:
        grouped[item.group_name].append(item)
    for group_items in grouped.values():
        group_items.sort(key=lambda x: (x.order_key[0], x.order_key[1], x.source_name.lower()))
    return dict(sorted(grouped.items(), key=lambda kv: kv[0].lower()))


def merge_group(output_dir: Path, group_name: str, items: list[SourcePdf]) -> tuple[Path, int]:
    writer = PdfWriter()
    total_pages = 0
    for item in items:
        reader = PdfReader(str(item.path))
        item.pages = len(reader.pages)
        total_pages += item.pages
        for page in reader.pages:
            writer.add_page(page)
    merged_path = output_dir / f"{safe_filename(group_name)} -{total_pages}.pdf"
    with merged_path.open("wb") as handle:
        writer.write(handle)
    return merged_path, total_pages


def build_zip(output_dir: Path, zip_path: Path) -> None:
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for pdf in sorted(output_dir.glob("*.pdf")):
            archive.write(pdf, arcname=pdf.name)


def write_report(
    report_path: Path,
    source: Path,
    output_dir: Path,
    zip_path: Path,
    items: list[SourcePdf],
    merged: list[dict[str, object]],
) -> None:
    total_source_pdfs = len(items)
    total_groups = len(merged)
    total_output_pages = sum(int(row["pages"]) for row in merged)
    lines: list[str] = [
        "merge_pdfs_by_product_name report",
        "=" * 80,
        f"source: {source}",
        f"output_dir: {output_dir}",
        f"zip_path: {zip_path}",
        f"total_source_pdfs: {total_source_pdfs}",
        f"total_groups: {total_groups}",
        f"total_output_pages: {total_output_pages}",
        "",
        "merged_files:",
    ]
    for row in merged:
        lines.append(
            f"{row['output']}\tpages={row['pages']}\tsources={row['source_count']}\tfirst={row['first_source']}"
        )
    lines.append("")
    lines.append("sources:")
    for item in items:
        lines.append(f"{item.group_name}\t{item.source_name}\t{item.path}")
    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def process(source: Path, output_dir: Path, zip_path: Path, report_path: Path) -> int:
    if not source.exists():
        print(f"Source not found: {source}", file=sys.stderr)
        return 2
    if source.is_file() and not (is_zip_path(source) or is_rar_path(source)):
        print("Only ZIP archives or folders are supported.", file=sys.stderr)
        return 2
    if is_rar_path(source):
        print("RAR is not supported for merge input. Please unpack it or provide a ZIP archive.", file=sys.stderr)
        return 2

    if output_dir.exists():
        shutil.rmtree(output_dir)
    ensure_dir(output_dir)
    if zip_path.exists():
        zip_path.unlink()

    items = collect_sources(source)
    grouped = group_sources(items)

    merged_rows: list[dict[str, object]] = []
    for group_name, group_items in grouped.items():
        merged_path, pages = merge_group(output_dir, group_name, group_items)
        merged_rows.append(
            {
                "group": group_name,
                "output": merged_path.name,
                "pages": pages,
                "source_count": len(group_items),
                "first_source": group_items[0].source_name if group_items else "",
            }
        )

    build_zip(output_dir, zip_path)
    write_report(report_path, source, output_dir, zip_path, items, merged_rows)

    print(f"source: {source}")
    print(f"output_dir: {output_dir}")
    print(f"zip_path: {zip_path}")
    print(f"total source pdfs: {len(items)}")
    print(f"merged groups: {len(merged_rows)}")
    print(f"output pdfs: {len(list(output_dir.glob('*.pdf')))}")
    print(f"report: {report_path}")
    return 0


def main() -> int:
    args = parse_args()
    source = Path(args.source).expanduser()
    output_dir = Path(args.output_dir).expanduser()
    zip_path = Path(args.zip_path).expanduser()
    report_path = Path(args.report_path).expanduser()
    ensure_dir(output_dir.parent)
    ensure_dir(report_path.parent)
    return process(source, output_dir, zip_path, report_path)


if __name__ == "__main__":
    raise SystemExit(main())
