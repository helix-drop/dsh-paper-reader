"""Apply an audited source-checked edit or cross-page note continuation to a chapter delivery."""
import argparse
import fcntl
import json
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('scripts')
parser.add_argument('document')
parser.add_argument('--chapter', required=True)
parser.add_argument('--mode', choices=['source_edit', 'note_continuation'], required=True)
parser.add_argument('--review-file', required=True)
args = parser.parse_args()

sys.path.insert(0, args.scripts)
import bounded_chapter as b
import note_continuation
import source_checked_edit

root = Path(args.document).resolve()
folder = root / f'ai_convert/delivery/chapter_{args.chapter}'
state_path = folder / 'state.json'
if not state_path.is_file():
    raise SystemExit(f'BLOCKED: chapter {args.chapter} delivery state missing')

review = json.loads(Path(args.review_file).read_text(encoding='utf-8'))
if not isinstance(review, dict):
    raise SystemExit('BLOCKED: review must be a JSON object')
review = dict(review)
review['chapter'] = str(args.chapter)
review.setdefault('status', 'source_checked_not_yet_applied')

with (folder / '.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    state = b.read_json(state_path)
    book = Path(state['book']).resolve()
    if not book.is_relative_to(folder.resolve()) or Path(state['source']).resolve() != root:
        raise ValueError('delivery source outside current task')
    info = next(c for c in b.read_json(book / 'ai_convert/chapters.json') if str(c['id']) == str(args.chapter))
    jobs = b.jobs_for(info, b.read_json(book / 'ai_convert/book_analysis.json'))
    if args.mode == 'note_continuation':
        row = note_continuation.apply(book, review)
    else:
        row = source_checked_edit.apply(book, review)
    report = b.export_result(book, str(args.chapter), jobs, folder, state)

print(json.dumps({
    'ok': True,
    'chapter': str(args.chapter),
    'mode': args.mode,
    'task': row.get('task'),
    'qualityStatus': report.get('quality_status'),
    'unverifiedPages': report.get('input_protocol', {}).get('unverified_pages', []),
    'errorCount': len(report.get('errors', [])),
    'errors': report.get('errors', [])[:12],
}, ensure_ascii=False))
