#!/usr/bin/env python3
"""Rebuild Teksher label PDFs from 321.csv with GTIN->product mapping.

Sources:
- /Users/admin/Desktop/321.csv
- /Users/admin/Desktop/Соня 1.xlsx
- /Users/admin/Desktop/ДЛЯ ЭТИКЕТКИ КИРГИЗИЯ.xlsx

Output:
- /Users/admin/Desktop/Соня_correct
- /Users/admin/Desktop/Соня_correct.zip
- /Users/admin/Desktop/Соня_correct/gtin_mapping.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from collections import Counter, defaultdict
from datetime import datetime
from typing import Any
from zipfile import ZipFile
from xml.etree import ElementTree as ET


RUNTIME_PYTHON = Path(
    "/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3.12"
)


def reexec_if_needed() -> None:
    if Path(sys.executable).resolve() == RUNTIME_PYTHON:
        return
    if RUNTIME_PYTHON.exists():
        os.execv(str(RUNTIME_PYTHON), [str(RUNTIME_PYTHON), *sys.argv])


reexec_if_needed()

from reportlab.lib import colors  # noqa: E402
from reportlab.lib.units import mm as MM  # noqa: E402
from reportlab.lib.utils import ImageReader  # noqa: E402
from reportlab.pdfbase import pdfmetrics  # noqa: E402
from reportlab.pdfbase.ttfonts import TTFont  # noqa: E402
from reportlab.pdfgen import canvas  # noqa: E402


NS = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}

SOURCE_KM_CSV = Path("/Users/admin/Desktop/321.csv")
SOURCE_NAMES_XLSX = Path("/Users/admin/Desktop/Соня 1.xlsx")
SOURCE_META_XLSX = Path("/Users/admin/Desktop/ДЛЯ ЭТИКЕТКИ КИРГИЗИЯ.xlsx")
OUTPUT_DIR = Path("/Users/admin/Desktop/Соня_correct_text")
ZIP_PATH = Path("/Users/admin/Desktop/Соня_correct_text.zip")
MAPPING_CSV = OUTPUT_DIR / "gtin_mapping.csv"

FONT_REGULAR_PATH = Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf")
FONT_BOLD_PATH = Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf")

PAGE_W = 58 * MM
PAGE_H = 40 * MM
LEFT_X = 3.0 * MM
LEFT_TOP = 34.0 * MM
LEFT_TEXT_WIDTH = 28.0 * MM
RIGHT_X = 33.0 * MM
RIGHT_Y = 6.0 * MM
BARCODE_SIZE = 22.0 * MM
GTIN_Y = 5.0 * MM
TAIL_Y = 2.8 * MM
MARGIN = 1.5 * MM


def register_fonts() -> tuple[str, str]:
    if FONT_REGULAR_PATH.exists():
        pdfmetrics.registerFont(TTFont("LabelRegular", str(FONT_REGULAR_PATH)))
        regular = "LabelRegular"
    else:
        regular = "Helvetica"
    if FONT_BOLD_PATH.exists():
        pdfmetrics.registerFont(TTFont("LabelBold", str(FONT_BOLD_PATH)))
        bold = "LabelBold"
    else:
        bold = "Helvetica-Bold"
    return regular, bold


FONT_REGULAR, FONT_BOLD = register_fonts()


def mm(value: float) -> float:
    return value * MM


def normalize_gtin(value: str) -> str:
    text = str(value or "").strip()
    if len(text) == 13 and text.isdigit():
        return "0" + text
    if len(text) >= 14 and text[:14].isdigit():
        return text[:14]
    return text


def extract_gts_from_km(km: str) -> str:
    text = str(km or "").strip()
    if text.startswith("01") and len(text) >= 16:
        return text[2:16]
    m = re.search(r"\b\d{14}\b", text)
    return m.group(0) if m else ""


def split_size_name(size_text: str) -> list[str]:
    size_text = size_text.strip()
    if size_text in {"XS/S", "M/L", "XL/2XL", "3XL/4XL"}:
        return [size_text]
    if size_text in {"XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "6XL"}:
        return [size_text]
    return [size_text]


def parse_xlsx_rows(path: Path) -> list[list[str]]:
    with ZipFile(path) as zf:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            ss = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in ss.findall("a:si", NS):
                shared.append("".join(si.itertext()))

        wb = ET.fromstring(zf.read("xl/workbook.xml"))
        rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        rel_map = {rel.attrib["Id"]: rel.attrib["Target"] for rel in rels}
        first_sheet = next(iter(wb.find("a:sheets", NS)))
        target = rel_map[first_sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]]
        xml = ET.fromstring(zf.read("xl/" + target))

        rows: list[list[str]] = []
        for row in xml.findall(".//a:sheetData/a:row", NS):
            values: list[str] = []
            for cell in row.findall("a:c", NS):
                t = cell.attrib.get("t")
                v = cell.find("a:v", NS)
                is_elem = cell.find("a:is", NS)
                text = ""
                if t == "s" and v is not None and v.text and v.text.isdigit():
                    idx = int(v.text)
                    text = shared[idx] if idx < len(shared) else v.text
                elif t == "inlineStr" and is_elem is not None:
                    text = "".join(is_elem.itertext())
                elif v is not None:
                    text = v.text or ""
                values.append(text)
            rows.append(values)
        return rows


def load_km_gtins(csv_path: Path) -> list[str]:
    gtins: list[str] = []
    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle)
        for row in reader:
            if not row:
                continue
            gtin = extract_gts_from_km(row[0])
            if gtin:
                gtins.append(gtin)
    return gtins


def load_gtin_names(path: Path) -> dict[str, str]:
    rows = parse_xlsx_rows(path)
    out: dict[str, str] = {}
    for row in rows[1:]:
        if len(row) < 2:
            continue
        gtin = normalize_gtin(row[0])
        name = row[1].strip()
        if gtin and name and name.lower() != "наименование":
            out[gtin] = name
    return out


def load_product_meta(path: Path) -> dict[tuple[str, str], dict[str, str]]:
    rows = parse_xlsx_rows(path)
    meta: dict[tuple[str, str], dict[str, str]] = {}
    for row in rows[2:]:
        if len(row) < 4:
            continue
        color = row[0].strip()
        title = row[1].strip()
        size = row[2].strip()
        article = row[3].strip()
        if not (color and title and size and article):
            continue
        meta[(title, color)] = {"article": article, "title": title}
    return meta


def family_for_name(name: str) -> tuple[str, str, str]:
    text = name.strip()
    if text.startswith("куртка оверсайз "):
        prefix = "куртка оверсайз "
        title = "Куртка демисезонная оверсайз с капюшоном"
        size_map = {
            "XS-S": "XS/S",
            "M-L": "M/L",
            "XL-2XL": "XL/2XL",
            "3XL-4XL": "3XL/4XL",
        }
    elif text.startswith("куртка С БЕЛЫМ "):
        prefix = "куртка С БЕЛЫМ "
        title = "Куртка демисезонная с капюшоном"
        size_map = {}
    elif text.startswith("ПАЛЬТО "):
        prefix = "ПАЛЬТО "
        title = "Пальто демисезонное стеганое с поясом длинное"
        size_map = {}
    else:
        raise ValueError(f"Unknown product family in name: {name}")

    remainder = text[len(prefix) :].strip()
    parts = remainder.split()
    if len(parts) < 2:
        raise ValueError(f"Cannot parse color/size from name: {name}")
    size = parts[-1]
    color = " ".join(parts[:-1])
    size = size_map.get(size, size)
    return title, color, size


def load_mapping(
    gtin_to_name: dict[str, str], meta: dict[tuple[str, str], dict[str, str]], km_gtins: set[str]
) -> tuple[list[dict[str, str]], list[str]]:
    mapping: list[dict[str, str]] = []
    missing: list[str] = []
    for gtin in sorted(km_gtins):
        name = gtin_to_name.get(gtin, "")
        if not name:
            missing.append(gtin)
            continue
        title, color, size = family_for_name(name)
        article_info = meta.get((title, color))
        if not article_info:
            missing.append(gtin)
            continue
        mapping.append(
            {
                "gtin": gtin,
                "title": title,
                "article": article_info["article"],
                "color": color,
                "size": size,
            }
        )
    return mapping, missing


def write_csv(path: Path, rows: list[dict[str, str]], fieldnames: list[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def wrap_title(title: str, font_name: str, font_size: float, width: float) -> list[str]:
    words = title.split()
    if not words:
        return [""]
    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        if pdfmetrics.stringWidth(candidate, font_name, font_size) <= width:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def extract_tail(marking_code: str, gtin: str) -> str:
    prefix = f"01{gtin}21"
    if marking_code.startswith(prefix):
        rest = marking_code[len(prefix) :]
        return rest.split("\x1d", 1)[0][-8:]
    cleaned = marking_code.replace("\x1d", "")
    return cleaned[-8:]


def render_datamatrix_png(marking_code: str, tmp_dir: Path, name: str) -> Path:
    out_path = tmp_dir / f"{name}.png"
    subprocess.run(
        ["zint", "-b", "71", "-o", str(out_path), "-d", marking_code],
        check=True,
    )
    return out_path


def draw_label_page(
    c: canvas.Canvas,
    marking_code: str,
    mapping_row: dict[str, str],
    index: int,
    total: int,
    tmp_dir: Path,
) -> None:
    gtin = mapping_row["gtin"]
    title = mapping_row["title"]
    article = mapping_row["article"]
    color = mapping_row["color"]
    size = mapping_row["size"]
    tail = extract_tail(marking_code, gtin)

    png_path = render_datamatrix_png(marking_code, tmp_dir, f"{index:04d}_{gtin}")
    barcode = ImageReader(str(png_path))

    c.setPageSize((PAGE_W, PAGE_H))
    c.setStrokeColor(colors.black)
    c.setLineWidth(0.6)
    c.rect(MARGIN, MARGIN, PAGE_W - 2 * MARGIN, PAGE_H - 2 * MARGIN)

    c.setFillColor(colors.black)
    text_size = 6.0
    leading = 4.3 * MM
    y = LEFT_TOP
    for line in wrap_title(title, FONT_REGULAR, text_size, LEFT_TEXT_WIDTH):
        c.setFont(FONT_REGULAR, text_size)
        c.drawString(LEFT_X, y, line)
        y -= leading

    for line in [
        f"Модель/Артикул: {article}",
        f"Цвет: {color}",
        f"Размер: {size}",
    ]:
        c.setFont(FONT_REGULAR, 5.8)
        c.drawString(LEFT_X, y, line)
        y -= 4.1 * MM

    c.drawImage(
        barcode,
        RIGHT_X,
        RIGHT_Y,
        width=BARCODE_SIZE,
        height=BARCODE_SIZE,
        mask="auto",
        preserveAspectRatio=True,
        anchor="sw",
    )
    c.setFont(FONT_BOLD, 5.7)
    c.drawCentredString(RIGHT_X + BARCODE_SIZE / 2, GTIN_Y, gtin)
    c.setFont(FONT_REGULAR, 5.0)
    c.drawCentredString(RIGHT_X + BARCODE_SIZE / 2, TAIL_Y, tail)
    c.setFont(FONT_REGULAR, 4.0)
    c.drawRightString(PAGE_W - MARGIN, 1.8, f"{index}/{total}")
    c.showPage()


def build_pdf(
    source_csv: Path,
    mapping_by_gtin: dict[str, dict[str, str]],
    output_dir: Path,
    zip_path: Path,
    limit: int = 0,
) -> dict[str, Any]:
    codes: list[str] = []
    with source_csv.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.reader(handle):
            if row and row[0].strip():
                codes.append(row[0].strip())
    if limit > 0:
        codes = codes[:limit]

    output_dir.mkdir(parents=True, exist_ok=True)
    if zip_path.exists():
        zip_path.unlink()

    used_counts: dict[str, int] = {}
    results: list[dict[str, Any]] = []

    with tempfile.TemporaryDirectory(prefix="sonya_correct_") as tmp:
        tmp_dir = Path(tmp)
        for index, km in enumerate(codes, start=1):
            gtin = extract_gts_from_km(km)
            mapping_row = mapping_by_gtin[gtin]
            base = gtin
            used_counts[base] = used_counts.get(base, 0) + 1
            if used_counts[base] > 1:
                base = f"{gtin}_{used_counts[base]}"
            pdf_path = output_dir / f"{base}.pdf"
            c = canvas.Canvas(str(pdf_path), pagesize=(PAGE_W, PAGE_H), pageCompression=1)
            c.setTitle(gtin)
            c.setAuthor("Codex")
            c.setSubject("Sonya correct Teksher label rebuild")
            draw_label_page(c, km, mapping_row, index, len(codes), tmp_dir)
            c.save()
            results.append(
                {
                    "index": index,
                    "gtin": gtin,
                    "output": str(pdf_path),
                    "article": mapping_row["article"],
                    "title": mapping_row["title"],
                    "color": mapping_row["color"],
                    "size": mapping_row["size"],
                }
            )

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for pdf in sorted(output_dir.glob("*.pdf")):
            archive.write(pdf, arcname=pdf.name)

    summary = {
        "sourceCsv": str(source_csv),
        "outputDir": str(output_dir),
        "zipPath": str(zip_path),
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "inputRows": len(codes),
        "pdfCount": len(list(output_dir.glob("*.pdf"))),
        "zipExists": zip_path.exists(),
    }
    (output_dir / "generation_report.json").write_text(
        json.dumps({"summary": summary, "results": results}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rebuild corrected Teksher PDFs for Sonya.")
    parser.add_argument("--limit", type=int, default=0, help="Optional max number of KM rows to render.")
    parser.add_argument("--test-only", action="store_true", help="Only build mapping and stop.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if not SOURCE_KM_CSV.exists():
        print(f"Missing source CSV: {SOURCE_KM_CSV}", file=sys.stderr)
        return 2
    if not SOURCE_NAMES_XLSX.exists():
        print(f"Missing source workbook: {SOURCE_NAMES_XLSX}", file=sys.stderr)
        return 2
    if not SOURCE_META_XLSX.exists():
        print(f"Missing source workbook: {SOURCE_META_XLSX}", file=sys.stderr)
        return 2

    km_gtins = set(load_km_gtins(SOURCE_KM_CSV))
    gtin_to_name = load_gtin_names(SOURCE_NAMES_XLSX)
    meta = load_product_meta(SOURCE_META_XLSX)
    mapping, missing = load_mapping(gtin_to_name, meta, km_gtins)

    if OUTPUT_DIR.exists():
        shutil.rmtree(OUTPUT_DIR)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if ZIP_PATH.exists():
        ZIP_PATH.unlink()
    if MAPPING_CSV.exists():
        MAPPING_CSV.unlink()
    write_csv(
        MAPPING_CSV,
        sorted(mapping, key=lambda r: r["gtin"]),
        ["gtin", "title", "article", "color", "size"],
    )

    counts = Counter()
    for row in mapping:
        counts[row["title"]] += 1

    print("mapping summary:")
    with SOURCE_KM_CSV.open("r", encoding="utf-8-sig") as handle:
        total_rows = sum(1 for _ in handle)
    print(f"  total km rows: {total_rows}")
    print(f"  unique GTINs in 321.csv: {len(km_gtins)}")
    print(f"  mapped GTINs: {len(mapping)}")
    print(f"  missing GTINs: {len(missing)}")
    if missing:
        print("missing_gtins:")
        for gtin in missing:
            print(gtin)
        return 1

    print("title distribution:")
    for title, count in sorted(counts.items()):
        print(f"  {title}: {count}")

    if args.test_only:
        return 0

    summary = build_pdf(SOURCE_KM_CSV, {row["gtin"]: row for row in mapping}, OUTPUT_DIR, ZIP_PATH, limit=args.limit)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"ZIP: {ZIP_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
