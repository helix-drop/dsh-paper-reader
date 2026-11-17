"""Preserve verified content provenance when only metadata.issues changes."""
import copy
import hashlib
import json
import re
from pathlib import Path


def is_continuation_marker(text):
    cleaned = re.sub(r'^[(\[\s]+|[)\]\s.]+$', '', str(text).strip()).lower()
    return cleaned in {'continued', 'cont', "cont'd", 'to be continued'}


def without_issues(value):
    result = copy.deepcopy(value)
    if not isinstance(result, dict):
        return result
    if isinstance(result.get('metadata'), dict):
        for key in ('issues', 'header_removed', 'footer_removed'):
            result['metadata'].pop(key, None)
    result.pop('paragraph_summary', None)
    result.pop('regions', None)
    if isinstance(result.get('paragraphs'), list):
        cleaned = []
        for p in result['paragraphs']:
            if isinstance(p, dict):
                if is_continuation_marker(p.get('text', '')):
                    continue
                for key in ('pid', 'kind', 'continues_from_prev', 'continues_to_next'):
                    p.pop(key, None)
                cleaned.append(p)
            else:
                cleaned.append(p)
        result['paragraphs'] = cleaned
    return result


def matches_verified_content(book, page, known):
    book = Path(book)
    name = f'page_{page:03d}.json'
    current = json.loads((book / 'ai_convert/edits/body' / name).read_text())
    candidates = []
    delivery = book.parent.parent
    # The accepted bytes are mirrored into later attempts, not only this page's own round.
    if delivery.name.startswith('chapter_'):
        candidates.extend(p.read_bytes() for p in delivery.glob(f'attempts/*/book/ai_convert/edits/body/{name}'))
    candidates.extend(p.read_bytes() for p in (book / 'ai_convert/delivery').glob(f'chapter_*/attempts/*/book/ai_convert/edits/body/{name}'))
    candidates.extend(p.read_bytes() for p in (book / 'ai_convert/delivery').glob(f'chapter_*/selected/book/ai_convert/edits/body/{name}'))
    audit = book / 'ai_convert/worker_audit.jsonl'
    if audit.exists():
        for line in audit.read_text().splitlines():
            try:
                row = json.loads(line)
                for key in ('normalization_before_json', 'normalization_after_json'):
                    if isinstance(row.get(key), str):
                        candidates.append(row[key].encode())
            except ValueError:
                continue
    for raw in candidates:
        if hashlib.sha256(raw).hexdigest() not in known:
            continue
        try:
            if without_issues(json.loads(raw)) == without_issues(current):
                return True
        except ValueError:
            continue
    return False


def valid_blank_receipt(row, known, book, name):
    """Replay an explicit image-reviewed correction of an OCR-only blank page."""
    try:
        if row.get('input_policy') != 'source_checked_blank_v1': return False
        before = row['normalization_before_json']; after = row['normalization_after_json']
        parent = hashlib.sha256(before.encode()).hexdigest(); review = row['source_review']
        if parent not in known or parent != row['parent_body_sha256']: return False
        if hashlib.sha256(after.encode()).hexdigest() != row['body_hashes'][name]: return False
        data = json.loads(before); page = data['book_page']
        if name != f'page_{page:03d}.json' or data.get('mode') != 'ocr_fallback': return False
        if review.get('status') != 'source_checked_blank' or review.get('page') != page or not review.get('basis'): return False
        image = Path(book)/f'ai_convert/page_images/page_{page:03d}.png'
        if hashlib.sha256(image.read_bytes()).hexdigest() != review['image_sha256']: return False
        data['paragraphs'] = []; data['regions'] = ['blank']
        if 'notes_definitions' in data: data['notes_definitions'] = []
        data['paragraph_summary'] = {'continues_from_prev':False,'continues_to_next':False,'complete_paragraph_count':0}
        data.setdefault('metadata',{}).setdefault('issues',[]).append('source_checked_blank: '+review['basis'])
        return json.loads(after) == data
    except (KeyError,TypeError,ValueError,OSError):
        return False
