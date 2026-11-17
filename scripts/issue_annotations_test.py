import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('annotations', Path(__file__).resolve().parents[1] / 'runtime/issue_annotations.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class AnnotationTests(unittest.TestCase):
    def test_only_issues_preserve_verified_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / 'chapter_001'
            book = folder / 'selected/book'
            selected = book / 'ai_convert/edits/body/page_001.json'
            original = folder / 'attempts/page_001_round_1/book/ai_convert/edits/body/page_001.json'
            selected.parent.mkdir(parents=True)
            original.parent.mkdir(parents=True)
            data = {'metadata': {'issues': [], 'kind': 'body'}, 'paragraphs': [{'text': 'Original words'}]}
            raw = json.dumps(data).encode()
            original.write_bytes(raw)
            known = {hashlib.sha256(raw).hexdigest()}
            data['metadata']['issues'] = ['gap_waived: source-page evidence']
            selected.write_text(json.dumps(data))
            self.assertTrue(m.matches_verified_content(book, 1, known))
            self.assertFalse(m.matches_verified_content(book, 1, set()))
            data['paragraphs'][0]['text'] = 'Changed words'
            selected.write_text(json.dumps(data))
            self.assertFalse(m.matches_verified_content(book, 1, known))
            data['paragraphs'][0]['text'] = 'Original words'
            data['metadata']['kind'] = 'heading'
            selected.write_text(json.dumps(data))
            self.assertFalse(m.matches_verified_content(book, 1, known))
            original.write_text('{}')
            self.assertFalse(m.matches_verified_content(book, 1, known))

    def test_mechanical_metadata_preserves_verified_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / 'chapter_001'
            book = folder / 'selected/book'
            selected = book / 'ai_convert/edits/body/page_001.json'
            original = folder / 'attempts/page_001_round_1/book/ai_convert/edits/body/page_001.json'
            selected.parent.mkdir(parents=True)
            original.parent.mkdir(parents=True)
            data = {
                'metadata': {'issues': []},
                'paragraphs': [{'pid': 'p1', 'kind': 'paragraph', 'continues_from_prev': False, 'continues_to_next': False, 'text': 'Original words', 'markers': ['1']}],
                'paragraph_summary': {'paragraph_count': 1}
            }
            raw = json.dumps(data).encode()
            original.write_bytes(raw)
            known = {hashlib.sha256(raw).hexdigest()}
            data['paragraphs'][0]['pid'] = 'p2'
            data['paragraphs'][0]['kind'] = 'heading'
            data['paragraphs'][0]['continues_from_prev'] = True
            data['paragraphs'][0]['continues_to_next'] = True
            data['paragraph_summary'] = {'paragraph_count': 1, 'updated': True}
            data['regions'] = []
            selected.write_text(json.dumps(data))
            self.assertTrue(m.matches_verified_content(book, 1, known))
            data['paragraphs'][0]['markers'] = ['2']
            selected.write_text(json.dumps(data))
            self.assertFalse(m.matches_verified_content(book, 1, known))

    def test_continuation_marker_excision_preserves_verified_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / 'chapter_016'
            book = folder / 'selected/book'
            selected = book / 'ai_convert/edits/body/page_280.json'
            original = folder / 'attempts/page_280_round_1/book/ai_convert/edits/body/page_280.json'
            selected.parent.mkdir(parents=True)
            original.parent.mkdir(parents=True)
            data = {
                'metadata': {'issues': []},
                'paragraphs': [
                    {'pid': 'p1', 'kind': 'body', 'continues_from_prev': True, 'text': '(continued)'},
                    {'pid': 'p2', 'kind': 'table', 'continues_from_prev': False, 'text': 'Col1\tCol2\nVal1\tVal2'}
                ],
                'paragraph_summary': {'continues_from_prev': True, 'complete_paragraph_count': 1}
            }
            raw = json.dumps(data).encode()
            original.write_bytes(raw)
            known = {hashlib.sha256(raw).hexdigest()}
            # Dropping the continuation marker paragraph should preserve content match
            data['paragraphs'] = [
                {'pid': 'p2', 'kind': 'table', 'continues_from_prev': False, 'text': 'Col1\tCol2\nVal1\tVal2'}
            ]
            data['paragraph_summary'] = {'continues_from_prev': False, 'complete_paragraph_count': 1}
            selected.write_text(json.dumps(data))
            self.assertTrue(m.matches_verified_content(book, 280, known))

if __name__ == '__main__':
    unittest.main()

