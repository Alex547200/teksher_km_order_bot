#!/usr/bin/env python3
"""Rename Teksher PDF labels by product metadata extracted from the PDF text.

The script accepts either a folder with PDFs, a ZIP archive containing PDFs,
or a RAR archive on macOS. RAR extraction uses `unar` when available, falls back
to `7z`, and can install `unar` through Homebrew if needed.

Output:
- renamed_pdfs_by_product/ (or a custom output directory)
- RENAMED_PDFS_BY_PRODUCT_NAME.zip (or a custom ZIP path)
- rename_report.txt (or a custom report path)

The script extracts the first page text, parses product title, color and size,
then writes renamed copies without modifying the source files.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import tempfile
import subprocess
import zipfile
from collections import Counter
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
    from PyPDF2 import PdfReader  # type: ignore
except Exception:  # pragma: no cover
    from pypdf import PdfReader  # type: ignore


DEFAULT_OUTPUT_DIR = Path("./renamed_pdfs_by_product")
DEFAULT_ZIP_PATH = Path("./RENAMED_PDFS_BY_PRODUCT_NAME.zip")
DEFAULT_REPORT_PATH = Path("./rename_report.txt")
SUPPORTED_SUFFIXES = {".pdf"}

FORBIDDEN_FILENAME_CHARS = {
    "\\": "_",
    "/": "_",
    ":": "_",
    "*": "_",
    "?": "_",
    "\"": "_",
    "<": "_",
    ">": "_",
    "|": "_",
}


@dataclass(slots=True)
class RenameResult:
    source: str
    target: str
    title: str
    color: str
    size: str
    status: str
    detail: str = ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rename Teksher PDF labels by product name.")
    parser.add_argument("--source", required=True, help="Path to a ZIP archive or a folder containing PDFs.")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="Output folder for renamed PDFs.")
    parser.add_argument("--zip-path", default=str(DEFAULT_ZIP_PATH), help="Output ZIP path.")
    parser.add_argument("--report-path", default=str(DEFAULT_REPORT_PATH), help="Text report path.")
    return parser.parse_args()


def is_rar_path(path: Path) -> bool:
    return path.suffix.lower() == ".rar"


def is_zip_path(path: Path) -> bool:
    return path.suffix.lower() == ".zip" or zipfile.is_zipfile(path)


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def has_command(name: str) -> bool:
    return shutil.which(name) is not None


def brew_prefix(formula: str) -> Path | None:
    brew = shutil.which("brew")
    if not brew:
        return None
    try:
        completed = subprocess.run(
            [brew, "--prefix", formula],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return None
    if completed.returncode != 0:
        return None
    prefix = completed.stdout.strip()
    return Path(prefix) if prefix else None


def resolve_unar_binary() -> str | None:
    candidates = [
        shutil.which("unar"),
        "/opt/homebrew/bin/unar",
        "/usr/local/bin/unar",
    ]
    prefix = brew_prefix("unar")
    if prefix:
        candidates.insert(0, str(prefix / "bin" / "unar"))
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    return None


def resolve_7z_binary() -> str | None:
    candidates = [
        shutil.which("7z"),
        "/opt/homebrew/bin/7z",
        "/usr/local/bin/7z",
        "/opt/homebrew/bin/7zr",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    return None


def install_unar_via_brew() -> bool:
    if not has_command("brew"):
        return False
    try:
        completed = subprocess.run(
            ["brew", "install", "unar"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return False
    if completed.returncode == 0:
        return True
    if resolve_unar_binary():
        return True
    return False


def extract_rar_to_temp(source: Path) -> Path:
    temp_dir = Path(tempfile.mkdtemp(prefix="rename_pdfs_rar_extract_"))
    print("RAR detected → extracting")

    extractor: list[str] | None = None
    unar_bin = resolve_unar_binary()
    z7_bin = resolve_7z_binary()
    if unar_bin:
        extractor = [unar_bin, "-o", str(temp_dir), "-q", str(source)]
    elif z7_bin:
        extractor = [z7_bin, "x", f"-o{temp_dir}", str(source)]
    else:
        print("unar not found → trying brew install unar")
        if install_unar_via_brew():
            unar_bin = resolve_unar_binary()
            if unar_bin:
                extractor = [unar_bin, "-o", str(temp_dir), "-q", str(source)]
        if extractor is None:
            z7_bin = resolve_7z_binary()
            if z7_bin:
                extractor = [z7_bin, "x", f"-o{temp_dir}", str(source)]

    if not extractor:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise RuntimeError("RAR is not supported directly. brew install unar failed and 7z is unavailable.")

    print(f"RAR extractor → {extractor[0]}")
    completed = subprocess.run(extractor, check=False, capture_output=True, text=True)
    if completed.returncode != 0:
        shutil.rmtree(temp_dir, ignore_errors=True)
        stderr = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(f"RAR extraction failed: {stderr or 'unknown error'}")

    return temp_dir


def safe_filename(name: str) -> str:
    text = str(name or "").replace("\x00", " ").replace("\r", " ").replace("\n", " ")
    for bad, repl in FORBIDDEN_FILENAME_CHARS.items():
        text = text.replace(bad, repl)
    text = re.sub(r"\s+", " ", text).strip(" .")
    text = re.sub(r"\s+", " ", text)
    return text or "unnamed"


def is_pdf_candidate(path: Path) -> bool:
    if not path.is_file():
        return False
    if path.suffix.lower() == ".pdf":
        return True
    try:
        with path.open("rb") as handle:
            return handle.read(4) == b"%PDF"
    except OSError:
        return False


def iter_pdf_sources(source: Path) -> Iterator[tuple[str, Path, bytes | None]]:
    if source.is_dir():
        for pdf in sorted(source.rglob("*")):
            if is_pdf_candidate(pdf):
                yield pdf.name, pdf, None
        return

    if is_zip_path(source):
        with tempfile.TemporaryDirectory(prefix="rename_pdfs_") as tmp:
            extract_dir = Path(tmp)
            with zipfile.ZipFile(source, "r") as archive:
                archive.extractall(extract_dir)
            for pdf in sorted(extract_dir.rglob("*")):
                if is_pdf_candidate(pdf):
                    yield pdf.name, pdf, None
        return

    if is_rar_path(source):
        temp_dir = extract_rar_to_temp(source)
        try:
            extracted_total = sum(1 for item in temp_dir.rglob("*") if item.is_file())
            print(f"RAR extracted files → {extracted_total}")
            for pdf in sorted(temp_dir.rglob("*")):
                if is_pdf_candidate(pdf):
                    yield pdf.name, pdf, None
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)
        return

    raise ValueError(f"Unsupported source type: {source}")


def read_first_page_text(pdf_path: Path) -> str:
    reader = PdfReader(str(pdf_path))
    if not reader.pages:
        return ""
    page = reader.pages[0]
    return page.extract_text() or ""


def clean_lines(text: str) -> list[str]:
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
    return [line for line in lines if line]


def is_known_label(line: str) -> bool:
    lower = line.lower()
    return any(
        lower.startswith(prefix)
        for prefix in (
            "модель/артикул",
            "цвет",
            "размер",
            "код товара",
            "способ формирования серийного номера",
            "автоматически",
            "код маркировки",
            "количество кодов маркировки",
            "информация о товаре",
            "статус операции",
            "результат обработки",
            "товарная группа",
            "страна операции",
            "дата создания операции",
            "дата начала обработки",
            "дата завершения операции",
            "дата последнего обновления",
            "печать кодов маркировки",
            "подтвердить",
            "отменить",
        )
    )


def looks_like_title_line(line: str) -> bool:
    text = line.strip()
    if not text or is_known_label(text):
        return False
    if re.fullmatch(r"[\d\s./:;,_-]+", text):
        return False
    if len(text) <= 1:
        return False
    if not re.search(r"[а-яёa-z]", text, re.IGNORECASE):
        return False
    # Pure uppercase lines are usually values like colors or codes, not titles.
    if text.upper() == text and re.search(r"[A-ZА-Я]", text):
        return False
    return True


def longest_title_block(lines: list[str]) -> list[str]:
    best: list[str] = []
    current: list[str] = []
    for line in lines:
        if looks_like_title_line(line):
            current.append(line)
        else:
            if len(current) > len(best):
                best = current[:]
            current = []
    if len(current) > len(best):
        best = current[:]
    return best


def parse_label_fields(text: str) -> tuple[str, str, str]:
    lines = clean_lines(text)
    color = ""
    size = ""

    for idx, line in enumerate(lines):
        lower = line.lower()
        if lower.startswith("цвет"):
            color_value = line.split(":", 1)[1].strip() if ":" in line else ""
            if not color_value and idx + 1 < len(lines):
                color_value = lines[idx + 1].strip()
            color = color_value or color
        elif lower.startswith("размер"):
            size_value = line.split(":", 1)[1].strip() if ":" in line else ""
            if not size_value and idx + 1 < len(lines):
                size_value = lines[idx + 1].strip()
            size = size_value or size

    title_candidates = longest_title_block(lines)
    if not title_candidates:
        # Fallback around the model/article label if the main block was not detected.
        for idx, line in enumerate(lines):
            if line.lower().startswith("модель/артикул"):
                before = lines[:idx]
                after = lines[idx + 1 :]
                title_candidates = longest_title_block(before)
                if len(title_candidates) < 2:
                    alt = longest_title_block(after)
                    if len(alt) > len(title_candidates):
                        title_candidates = alt
                break

    title = " ".join(title_candidates).strip()
    title = re.sub(r"\s+", " ", title)
    title = title or "unknown"
    color = color or "UNKNOWN"
    size = size or "UNKNOWN"
    return title, color, size


def make_target_name(title: str, color: str, size: str, used: Counter[str]) -> str:
    base = safe_filename(f"{title} {color} {size}")
    if not base:
        base = "unnamed"
    used[base] += 1
    if used[base] == 1:
        return f"{base}.pdf"
    return f"{base}_{used[base]}.pdf"


def copy_pdf(src: Path, dst: Path) -> None:
    ensure_dir(dst.parent)
    shutil.copy2(src, dst)


def build_zip(output_dir: Path, zip_path: Path) -> None:
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for pdf in sorted(output_dir.glob("*.pdf")):
            archive.write(pdf, arcname=pdf.name)


def write_report(report_path: Path, results: list[RenameResult], summary: dict[str, object]) -> None:
    lines: list[str] = []
    lines.append("rename_pdfs_by_product report")
    lines.append("=" * 80)
    for key, value in summary.items():
        lines.append(f"{key}: {value}")
    lines.append("")
    lines.append("files:")
    for item in results:
        lines.append(
            f"{item.status}\t{item.source}\t->\t{item.target}\t| title={item.title}\t| color={item.color}\t| size={item.size}\t| {item.detail}"
        )
    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def process(source: Path, output_dir: Path, zip_path: Path, report_path: Path) -> int:
    if not source.exists():
        message = f"Source not found: {source}"
        report_path.write_text(message + "\n", encoding="utf-8")
        print(message)
        return 2

    if source.is_file() and not (is_zip_path(source) or is_rar_path(source)):
        message = "Only ZIP archives, RAR archives, or folders are supported."
        report_path.write_text(message + "\n", encoding="utf-8")
        print(message)
        return 2

    if output_dir.exists():
        shutil.rmtree(output_dir)
    ensure_dir(output_dir)
    if zip_path.exists():
        zip_path.unlink()

    results: list[RenameResult] = []
    used_names: Counter[str] = Counter()
    total_source_pdfs = 0
    parsed_ok = 0
    parse_failed = 0

    pdf_iter: Iterable[tuple[str, Path, bytes | None]]
    if source.is_dir() or is_zip_path(source) or is_rar_path(source):
        pdf_iter = iter_pdf_sources(source)
    else:
        pdf_iter = []

    for display_name, pdf_path, _ in pdf_iter:
        total_source_pdfs += 1
        try:
            text = read_first_page_text(pdf_path)
            title, color, size = parse_label_fields(text)
            target_name = make_target_name(title, color, size, used_names)
            target_path = output_dir / target_name
            copy_pdf(pdf_path, target_path)
            results.append(
                RenameResult(
                    source=display_name,
                    target=target_name,
                    title=title,
                    color=color,
                    size=size,
                    status="renamed",
                )
            )
            parsed_ok += 1
        except Exception as exc:  # pragma: no cover
            parse_failed += 1
            results.append(
                RenameResult(
                    source=display_name,
                    target="",
                    title="",
                    color="",
                    size="",
                    status="failed",
                    detail=str(exc),
                )
            )

    build_zip(output_dir, zip_path)

    summary = {
        "source": str(source),
        "source_type": "folder" if source.is_dir() else ("rar" if is_rar_path(source) else "zip"),
        "total_source_pdfs": total_source_pdfs,
        "parsed_ok": parsed_ok,
        "parse_failed": parse_failed,
        "output_dir": str(output_dir),
        "zip_path": str(zip_path),
        "report_path": str(report_path),
    }
    write_report(report_path, results, summary)
    if is_rar_path(source):
        print(f"RAR detected → extracting → found {total_source_pdfs} PDFs → renamed {parsed_ok} PDFs")
    print("\n".join([f"{k}: {v}" for k, v in summary.items()]))
    return 0 if parse_failed == 0 else 1


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
