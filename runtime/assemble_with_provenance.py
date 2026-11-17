"""Run the existing deterministic assembler and retain its rendering provenance.

No generation, OCR reconstruction, page JSON edits or budget changes occur here.
"""
import argparse
import builtins
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import sys
import uuid


def sha(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def tidy(text):
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def load_runtime(root, name):
    directory = Path(root) / '.kimi-code/skills/fnm-ai-convert/scripts'
    if not directory.exists():
        directory = Path('/Users/hao/Library/Application Support/DSH/PaperReader/.kimi-code/skills/fnm-ai-convert/scripts')
    sys.path.insert(0, str(directory))
    spec = importlib.util.spec_from_file_location(name, directory / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_map(file, spans, inputs, runtime):
    # Sidecars cannot silently survive a different Markdown or runtime version.
    out = Path(str(file) + '.provenance.json')
    data = {'schemaVersion': 1, 'markdownSha256': sha(file), 'spans': spans,
            'inputs': inputs, 'runtimeSha256': sha(runtime), 'generator': 'dsh-assembly-v1', 'wrapperSha256': sha(__file__)}
    temporary = out.with_suffix(out.suffix + '.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(out)


def chapter(root, book, chapter_id):
    module = load_runtime(root, 'assemble_chapter')
    chapter_def = next(c for c in module._load(book / 'ai_convert/chapters.json') if c['id'] == chapter_id)
    evidence = [book / 'ai_convert/edits/body' / f'page_{p:03d}.json'
                for p in range(chapter_def['start_page'], chapter_def['end_page'] + 1)]
    evidence += [book / 'ai_convert/edits/notes' / ('chapter_' + chapter_id + '.json'),
                 book / 'ai_convert/chapters.json', book / 'ai_convert/book_analysis.json',
                 book / 'raw_pages.json']
    snapshot = {str(p.relative_to(book)): sha(p) for p in evidence if p.exists()}
    folder = chapter_id + '-' + module._slugify(module._chapter_title(chapter_def))
    file = book / 'ai_convert/chapters' / folder / (folder + '.md')
    class Capture(io.StringIO):
        def close(self):
            if self.closed:
                return
            self.value = self.getvalue()
            super().close()
    capture = Capture()
    def traced_open(target, mode='r', *args, **kwargs):
        if Path(target) == file and 'w' in mode:
            return capture
        return builtins.open(target, mode, *args, **kwargs)
    records, originals = [], {}
    for name in ('_render_paragraph', '_render_footnote_block', '_render_endnote_definition'):
        original = getattr(module, name)
        originals[name] = original
        def render(item, *args, original=original, name=name, **kwargs):
            rendered = original(item, *args, **kwargs)
            if name == '_render_paragraph':
                record = {'sourcePids': item['pid_chain'], 'kind': 'body'}
            else:
                pages = [item.get('source_page'), item.get('continued_on_page')]
                record = {'sourcePids': [item['anchor']], 'kind': 'note',
                          'logicalPages': sorted(set(p for p in pages if type(p) is int and p > 0))}
            if not rendered.strip():
                return rendered
            token = uuid.uuid4().hex
            start, end = '<!--dsh-span-' + token + '-->', '<!--/dsh-span-' + token + '-->'
            records.append({**record, 'startToken': start, 'endToken': end, 'chapterId': chapter_id})
            return start + rendered + end
        setattr(module, name, render)
    # Trace-only Markdown stays in memory. Existing readable Markdown never
    # contains temporary markers, even if this process is interrupted.
    module.open = traced_open
    try:
        ok, messages = module.assemble(str(book), chapter_id)
    finally:
        module.open = builtins.open
    if not ok:
        raise ValueError('\n'.join(messages))
    decorated = capture.value
    # Re-run the unmodified renderer to retain its exact bytes. Both calls are
    # deterministic checks/assembly only; neither consumes any model budget.
    for name, original in originals.items():
        setattr(module, name, original)
    ok, messages = module.assemble(str(book), chapter_id)
    if not ok:
        raise ValueError('\n'.join(messages))
    text = file.read_text()
    clean = decorated
    for record in records:
        clean = clean.replace(record['startToken'], '').replace(record['endToken'], '')
    if clean.rstrip() + '\n' != text.rstrip() + '\n':
        raise ValueError('Rendering boundaries changed Markdown whitespace; provenance cannot be certified')
    pid_pages, inputs = {}, []
    for p in sorted((book / 'ai_convert/edits/body').glob('page_*.json')):
        data = json.loads(p.read_text())
        if not chapter_def['start_page'] <= data['book_page'] <= chapter_def['end_page']:
            continue
        inputs.append({'file': str(p.relative_to(book)), 'sha256': sha(p)})
        for para in data.get('paragraphs', []):
            if para['pid'] in pid_pages:
                raise ValueError('Duplicate source paragraph identifier')
            pid_pages[para['pid']] = data['book_page']
    for p in [book / 'ai_convert/edits/notes' / ('chapter_' + chapter_id + '.json'),
              book / 'ai_convert/chapters.json', book / 'ai_convert/book_analysis.json']:
        if p.exists():
            inputs.append({'file': str(p.relative_to(book)), 'sha256': sha(p)})
    spans, cursor = [], 0
    for record in records:
        start_token, end_token = record.pop('startToken'), record.pop('endToken')
        start = decorated.find(start_token, cursor)
        end = decorated.find(end_token, start + len(start_token))
        if start < 0 or end < 0:
            raise ValueError('Assembler provenance does not match rendered Markdown')
        cursor = end + len(end_token)
        if 'logicalPages' not in record:
            record['logicalPages'] = sorted(set(pid_pages[p] for p in record['sourcePids']))
        spans.append({**record, 'startLine': decorated[:start].count('\n') + 1,
                      'endLine': decorated[:end].count('\n') + 1})
    if any(not (book / file).exists() or sha(book / file) != digest for file, digest in snapshot.items()):
        raise ValueError('Assembly inputs changed during rendering')
    write_map(file, spans, [{'file': f, 'sha256': h} for f, h in snapshot.items()], module.__file__)
    print(json.dumps({'markdown': str(file), 'spans': len(spans)}))


def book_map(root, book, title=None):
    module = load_runtime(root, 'assemble_book')
    chapters = module.load_chapters(str(book))
    # Keep the original renderer and namespace transformation authoritative.
    inputs, transformed = [], []
    for c in chapters:
        file = Path(module.find_chapter_md(str(book / 'ai_convert/chapters'), c['id']))
        sidecar = Path(str(file) + '.provenance.json')
        data = json.loads(sidecar.read_text())
        if data['markdownSha256'] != sha(file):
            raise ValueError('Chapter provenance is stale')
        transformed.append((module.namespace_anchors(file.read_text(), c['id']).strip(), data))
        inputs.append({'file': str(file.relative_to(book)), 'sha256': sha(file)})
        inputs.append({'file': str(sidecar.relative_to(book)), 'sha256': sha(sidecar)})
    module.assemble(str(book), None, False)
    if any(sha(book / item['file']) != item['sha256'] for item in inputs):
        raise ValueError('Chapter inputs changed during book assembly')
    file = book / 'ai_convert/book' / book.name / (book.name + '-full.md')
    if title:
        # Task document directories are named document, not the book title.
        # Change generated metadata only; retain stable output paths and all
        # transcribed chapter bytes and namespace transformations.
        heading = '# ' + ' '.join(title.split())
        for output in [file, file.parent / ('00-' + book.name + '.md')]:
            lines = output.read_text().split('\n')
            lines[0] = heading
            output.write_text('\n'.join(lines))
    text, spans, cursor = file.read_text(), [], 0
    for rendered, data in transformed:
        start = text.find(rendered, cursor)
        if start < 0:
            raise ValueError('Book provenance does not match rendered Markdown')
        cursor = start + len(rendered)
        offset = text[:start].count('\n')
        spans.extend({**s, 'startLine': s['startLine'] + offset, 'endLine': s['endLine'] + offset}
                     for s in data['spans'])
    write_map(file, spans, inputs, module.__file__)
    print(json.dumps({'markdown': str(file), 'spans': len(spans)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('book', type=Path)
    parser.add_argument('--chapter')
    parser.add_argument('--title')
    args = parser.parse_args()
    book = args.root / args.book if not args.book.is_absolute() else args.book
    if args.chapter:
        chapter(args.root, book, args.chapter)
    else:
        book_map(args.root, book, args.title)
