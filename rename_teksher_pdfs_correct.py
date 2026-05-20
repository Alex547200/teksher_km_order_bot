from pathlib import Path
import argparse
import zipfile
import shutil
import re
from collections import Counter
from pypdf import PdfReader


REPLACEMENTS = {
    "апюшоном Куртка демисезонная с к": "Куртка демисезонная с капюшоном",
    "рсайз с капюшоном Куртка демисезонная ове": "Куртка демисезонная оверсайз с капюшоном",
    "ганое Пальто демисезонное сте": "Пальто демисезонное стеганое",
}


def clean_name(value: str) -> str:
    value = re.sub(r"\s+", " ", value or "").strip()
    value = value.replace("/", "-").replace("\\", "-").replace(":", "")
    return value


def extract_zip(source: Path, extract_dir: Path):
    with zipfile.ZipFile(source, "r") as zf:
        zf.extractall(extract_dir)


def build_name_from_pdf(pdf_path: Path) -> str:
    reader = PdfReader(str(pdf_path))
    text = reader.pages[0].extract_text() or ""

    lines = [x.strip() for x in text.splitlines() if x.strip()]

    size = ""
    color = ""
    product_lines = []

    for i, line in enumerate(lines):
        if line == "Размер:" and i + 1 < len(lines):
            size = lines[i + 1]

        if line == "Цвет:" and i + 1 < len(lines):
            color = lines[i + 1]

        if line == "Модель/Артикул:" and i + 1 < len(lines):
            product_lines = lines[i + 2:i + 5]

    product_name = " ".join(product_lines)

    for bad, good in REPLACEMENTS.items():
        product_name = product_name.replace(bad, good)

    product_name = clean_name(product_name)
    color = clean_name(color)
    size = clean_name(size)

    if not product_name:
        product_name = "UNKNOWN_PRODUCT"

    return clean_name(f"{product_name} {color} {size}.pdf")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="ZIP или папка с PDF")
    parser.add_argument("--output-dir", default="renamed_pdfs_by_product")
    parser.add_argument("--zip-path", default="RENAMED_PDFS_BY_PRODUCT_NAME.zip")
    parser.add_argument("--report-path", default="rename_report.txt")
    args = parser.parse_args()

    source = Path(args.source).expanduser()
    output_dir = Path(args.output_dir)
    zip_path = Path(args.zip_path)
    report_path = Path(args.report_path)

    work_dir = Path("tmp/rename_teksher_pdfs_correct")
    extract_dir = work_dir / "extract"

    if work_dir.exists():
        shutil.rmtree(work_dir)
    if output_dir.exists():
        shutil.rmtree(output_dir)
    if zip_path.exists():
        zip_path.unlink()

    extract_dir.mkdir(parents=True)
    output_dir.mkdir(parents=True)

    if source.is_file() and source.suffix.lower() == ".zip":
        extract_zip(source, extract_dir)
        pdf_files = list(extract_dir.rglob("*.pdf"))
    elif source.is_dir():
        pdf_files = list(source.rglob("*.pdf"))
    else:
        raise SystemExit(f"Unsupported source: {source}")

    used_names = Counter()
    report_lines = []

    parsed_ok = 0
    parse_failed = 0

    for pdf_path in pdf_files:
        try:
            final_name = build_name_from_pdf(pdf_path)

            used_names[final_name] += 1
            if used_names[final_name] > 1:
                stem = final_name[:-4]
                final_name = f"{stem} ({used_names[final_name]}).pdf"

            shutil.copy2(pdf_path, output_dir / final_name)

            parsed_ok += 1
            report_lines.append(f"OK: {pdf_path.name} => {final_name}")

        except Exception as e:
            parse_failed += 1
            report_lines.append(f"FAILED: {pdf_path.name} => {e}")

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file in output_dir.rglob("*.pdf"):
            zf.write(file, arcname=file.name)

    report_path.write_text(
        f"source: {source}\n"
        f"total_source_pdfs: {len(pdf_files)}\n"
        f"parsed_ok: {parsed_ok}\n"
        f"parse_failed: {parse_failed}\n"
        f"output_dir: {output_dir}\n"
        f"zip_path: {zip_path}\n"
        f"report_path: {report_path}\n\n"
        + "\n".join(report_lines),
        encoding="utf-8",
    )

    print("DONE")
    print(f"total_source_pdfs: {len(pdf_files)}")
    print(f"parsed_ok: {parsed_ok}")
    print(f"parse_failed: {parse_failed}")
    print(f"output_dir: {output_dir}")
    print(f"zip_path: {zip_path}")
    print(f"report_path: {report_path}")


if __name__ == "__main__":
    main()
