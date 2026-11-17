"""Revalidate completed chapter deliveries without model calls or budget writes.

export_result may append a deterministic_summary_v1 receipt, or an
adopted_page_definitions_v1 receipt for definitions copied from an accepted
page. It does not change state.json or attempt budgets.
"""
import argparse
import fcntl
import json
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('scripts')
parser.add_argument('document')
parser.add_argument('--chapter', default=None)
args = parser.parse_args()
sys.path.insert(0, args.scripts)
import bounded_chapter as b
root = Path(args.document).resolve()
checked = []
canonical_ids = None
if not args.chapter and (root / 'ai_convert/chapters.json').is_file():
    chapters_list = b.read_json(root / 'ai_convert/chapters.json') or []
    if isinstance(chapters_list, list) and chapters_list:
        canonical_ids = {str(c['id']) for c in chapters_list if isinstance(c, dict) and c.get('id') is not None}
folders = ([root / f'ai_convert/delivery/chapter_{args.chapter}'] if args.chapter
           else [p for p in sorted((root / 'ai_convert/delivery').glob('chapter_*'))
                 if canonical_ids is None or p.name[len('chapter_'):] in canonical_ids])
for folder in folders:
    state_path = folder / 'state.json'
    if not state_path.exists():
        continue
    with (folder / '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = b.read_json(state_path)
        book = Path(state['book']).resolve()
        if not book.is_relative_to(folder.resolve()) or Path(state['source']).resolve() != root:
            raise ValueError('delivery source outside current task')
        chapter = state['chapter']
        info = next(c for c in b.read_json(book / 'ai_convert/chapters.json') if str(c['id']) == chapter)
        jobs = b.jobs_for(info, b.read_json(book / 'ai_convert/book_analysis.json'))
        if not state.get('finished'):
            from conditional_rescue import recover_attempt_states, recover_selection
            recover_selection(book, folder)
            recover_attempt_states(folder, state)
            all_verified = all(
                b.independent_vision_page(book, page) or b.authorized_fallback_page(book, page)
                for task, page in jobs if task == 'body'
            )
            if not all_verified and not args.chapter:
                continue
            b.atomic_json(state_path, state)
        report = b.export_result(book, chapter, jobs, folder, state)
        if not state.get('finished') and report.get('quality_status') == 'program_checks_passed':
            state['finished'] = True
            b.atomic_json(state_path, state)
        checked.append({'chapter': chapter, 'quality': report['quality_status'], 'errors': report['errors']})
print(json.dumps(checked, ensure_ascii=False))
if not checked or any(c['quality'] != 'program_checks_passed' for c in checked):
    sys.exit(1)
