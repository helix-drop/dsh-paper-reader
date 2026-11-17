"""Crop a requested PDF region and submit once; reuse completed or pending jobs."""
import argparse
import contextlib
import fcntl
import hashlib
import io
import json
import math
import sys
from pathlib import Path


def bounds(value):
    if not isinstance(value, list) or len(value) != 4 or any(type(x) not in (int, float) or not math.isfinite(x) for x in value):
        raise ValueError('region must contain four finite coordinates')
    x0, y0, x1, y1 = value
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        raise ValueError('region must be [left, top, right, bottom] within 0..1')
    normalized = [round(float(x), 6) for x in value]
    if normalized[0] >= normalized[2] or normalized[1] >= normalized[3]:
        raise ValueError('region is too small')
    return normalized


def execute(pdf, page, region, out, runtime, config, reason, provider=None):
    import fitz
    pdf, out = Path(pdf), Path(out)
    region = bounds(region)
    source = hashlib.sha256(pdf.read_bytes()).hexdigest()
    sys.path.insert(0, str(runtime))
    if provider is None:
        import paddle_ocr as provider
    model = provider.resolve_default_model(str(config))
    identity = dict(source=source, page=page, region=region, engine='paddle', model=model)
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    directory = out / key
    directory.mkdir(parents=True, exist_ok=True)
    def save(name, data):
        tmp = directory / (name + '.tmp')
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
        tmp.replace(directory / name)
    with (directory / '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        result_file = directory / 'result.json'
        if result_file.exists():
            return dict(json.loads(result_file.read_text()), reused=True)
        with fitz.open(pdf) as doc:
            if type(page) is not int or not 1 <= page <= len(doc):
                raise ValueError('page is outside the normalized PDF')
            original = doc[page - 1]
            x0, y0, x1, y1 = region
            clip = fitz.Rect(x0 * original.rect.width, y0 * original.rect.height, x1 * original.rect.width, y1 * original.rect.height)
            scale = min(2.5, 4096 / max(clip.width, clip.height))
            pix = original.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=clip, alpha=False)
            image = directory / 'crop.png'
            pix.save(image)
            # Only the selected pixels leave the machine, including for PDFs
            # whose hidden text outside the crop would survive a PDF clip.
            crop = fitz.open()
            target = crop.new_page(width=clip.width, height=clip.height)
            target.insert_image(target.rect, stream=pix.tobytes('png'))
            crop.save(directory / 'crop.pdf')
            crop.close()
        request_file = directory / 'request.json'
        request = json.loads(request_file.read_text()) if request_file.exists() else None
        token = provider.resolve_token(str(config))
        if not token:
            raise ValueError('PaddleOCR credential is not configured')
        if request and not request.get('jobId'):
            raise ValueError('Prior submission has unknown status; refusing duplicate billing. Recover its job ID before retrying.')
        with contextlib.redirect_stdout(io.StringIO()):
            if not request:
                request = dict(identity, status='submitting', reason=reason)
                save('request.json', request)
                request['jobId'] = provider.submit_job(provider.DEFAULT_JOB_URL, token, str(directory / 'crop.pdf'), model)
                request['status'] = 'submitted'
                save('request.json', request)
            url = provider.poll_job(provider.DEFAULT_JOB_URL, token, request['jobId'])
            raw = directory / 'response.jsonl'
            provider.download_jsonl(url, str(raw))
            pages = provider.jsonl_to_raw_pages(raw.read_text(), model)
        if len(pages) != 1:
            raise ValueError('OCR response must contain exactly one cropped page')
        if hashlib.sha256(pdf.read_bytes()).hexdigest() != source:
            raise ValueError('PDF changed during OCR; result not adopted')
        save('ocr-page.json', pages[0])
        text = pages[0].get('markdown', '')
        notes = pages[0].get('footnotes', '')
        if isinstance(notes, str) and notes.strip() and notes.strip() not in text:
            text += '\n\n' + notes
        result = dict(page=page, region=region, engine='paddle', model=model, cropImage=str(image),
                      text=text, rawFile=str(directory / 'ocr-page.json'), verified=False, reused=False,
                      notice='OCR evidence for the selected region only; compare with the original image.')
        save('result.json', result)
        return result


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf'); ap.add_argument('--page', type=int, required=True)
    ap.add_argument('--region', type=json.loads, required=True)
    ap.add_argument('--out', required=True); ap.add_argument('--runtime', required=True)
    ap.add_argument('--config', required=True); ap.add_argument('--reason', default='')
    args = ap.parse_args()
    try:
        print(json.dumps(execute(args.pdf, args.page, args.region, args.out, args.runtime, args.config, args.reason), ensure_ascii=False))
    except (Exception, SystemExit) as exc:
        # Provider errors can include response bodies. Keep them out of tool
        # output; the retained request ID still supports polling after failure.
        print(json.dumps({'error': type(exc).__name__, 'message': str(exc) if isinstance(exc, ValueError) else 'OCR request failed; saved submission will be reused.'}), file=sys.stderr)
        sys.exit(1)
