"""Render only explicitly requested original PDF pages for visual review."""
import argparse
import json
from pathlib import Path
import pymupdf

parser = argparse.ArgumentParser()
parser.add_argument('pdf')
parser.add_argument('output')
parser.add_argument('--pages', required=True)
args = parser.parse_args()
pages = json.loads(args.pages)
if not isinstance(pages, list) or not pages or len(pages) > 16 or any(type(p) is not int for p in pages):
    raise ValueError('invalid review page list')
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
with pymupdf.open(args.pdf) as doc:
    if any(p < 1 or p > len(doc) for p in pages):
        raise ValueError('review page outside original PDF')
    for number in sorted(set(pages)):
        page = doc[number - 1]
        scale = min(2.5, 2400 / max(page.rect.width, page.rect.height))
        pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
        pix.save(out / f'page-{number:04d}.png')
print(json.dumps({'pages': sorted(set(pages))}))
