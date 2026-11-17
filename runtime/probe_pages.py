"""runtime/probe_pages.py — 受控的 PDF 页面探测与按需渲染。
支持从原始或规范化 PDF 中受控探测指定页码，提取文本层文本、版面尺寸及渲染高清原页图像。
"""
import argparse
import json
import sys
from pathlib import Path

try:
    import pymupdf as fitz
except ImportError:
    import fitz


def probe(pdf_path, output_dir, pages, text_limit=4000):
    pdf = Path(pdf_path)
    if not pdf.exists():
        raise FileNotFoundError(f"PDF 文件不存在: {pdf_path}")

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    if not isinstance(pages, list) or not pages:
        raise ValueError("请指定至少一个有效页码")
    if len(pages) > 8:
        raise ValueError("单次页面探测最多支持 8 个页面")
    if any(type(p) is not int or p < 1 for p in pages):
        raise ValueError("页码必须为正整数")

    results = []
    with fitz.open(pdf) as doc:
        total = len(doc)
        for page_num in pages:
            if page_num > total:
                raise ValueError(f"页码 {page_num} 超出文档总页数 (1-{total})")

            p = doc[page_num - 1]
            rect = p.rect
            width, height = round(rect.width), round(rect.height)

            raw_text = p.get_text() or ""
            text_len = len(raw_text)
            truncated = text_len > text_limit
            text_sample = raw_text[:text_limit] if truncated else raw_text

            headings = []
            for line in raw_text.splitlines()[:20]:
                clean = line.strip()
                if 2 <= len(clean) <= 120:
                    headings.append(clean)
                if len(headings) >= 5:
                    break

            target_img = out / f"page_{page_num:04d}.png"
            max_dim = max(rect.width, rect.height)
            scale = min(2.0, 2000 / max_dim) if max_dim > 0 else 1.5
            pix = p.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            pix.save(target_img)
            try:
                target_img.chmod(0o600)
            except OSError:
                pass

            results.append({
                "page": page_num,
                "width": width,
                "height": height,
                "imagePath": str(target_img.resolve()),
                "hasText": bool(raw_text.strip()),
                "textLength": text_len,
                "textTruncated": truncated,
                "text": text_sample,
                "headings": headings
            })

        return {
            "pdfPath": str(pdf.resolve()),
            "totalPages": total,
            "count": len(results),
            "pages": results
        }


def main():
    parser = argparse.ArgumentParser(description="Probe and render PDF pages on demand")
    parser.add_argument("pdf", help="Path to PDF")
    parser.add_argument("output", help="Output directory for rendered page images")
    parser.add_argument("--pages", required=True, help="JSON list of 1-based page numbers")
    parser.add_argument("--text-limit", type=int, default=4000, help="Max characters of text layer to return per page")

    args = parser.parse_args()
    try:
        pages = json.loads(args.pages)
    except Exception as e:
        print(json.dumps({"error": f"pages 参数必须是有效的 JSON 数组: {e}"}), file=sys.stderr)
        sys.exit(1)

    try:
        data = probe(args.pdf, args.output, pages, text_limit=args.text_limit)
        print(json.dumps(data, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
