import importlib.util
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('analysis', Path(__file__).parents[1] / 'runtime/analyze_document.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)

class AnalysisTest(unittest.TestCase):
    def run_worker(self, worker, fallbacks=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.pdf'
            source.write_bytes(b'unchanged source')
            evidence = {**self.evidence(), 'type': 'pdf'}
            stream = io.StringIO()
            with patch.object(a, 'read_evidence', return_value=(evidence, ['page.png'])), patch.object(a.importlib.util, 'spec_from_file_location', return_value=Mock()), patch.object(a.importlib.util, 'module_from_spec', return_value=worker), contextlib.redirect_stdout(stream):
                report = a.analyze(source, root / 'out', root, 'primary', 'selected-model', 'paper', fallbacks=fallbacks)
            self.assertEqual(source.read_bytes(), b'unchanged source')
            return report, stream.getvalue()

    def worker(self):
        worker = Mock()
        worker.known_provider.return_value = True
        worker.get_provider_config.side_effect = lambda p, m: {'model': m, 'provider': p}
        worker.call_api.return_value = json.dumps({'fields': {'language': self.field('fr')}})
        return worker

    def test_primary_success_does_not_use_fallback(self):
        worker = self.worker()
        report, _ = self.run_worker(worker, [{'provider': 'fallback', 'model': 'approved'}])
        self.assertEqual(report['status'], 'complete')
        self.assertEqual(worker.call_api.call_count, 1)
        cfg = worker.call_api.call_args.args[0]
        self.assertTrue(cfg['bounded_attempt'])
        self.assertTrue(cfg['bounded_workflow'])
        self.assertEqual(cfg['model'], 'selected-model')

    def test_unknown_primary_uses_only_authorized_fallback(self):
        worker = self.worker()
        worker.known_provider.side_effect = lambda p: p != 'primary'
        report, events = self.run_worker(worker, [{'provider': 'fallback', 'model': 'approved'}])
        self.assertEqual(report['status'], 'complete')
        self.assertIsNone(report['failure'])
        self.assertEqual(report['attempts'][0]['errorCode'], 'unknown_provider')
        self.assertEqual(report['selectedModel'], {'provider': 'fallback', 'model': 'approved'})
        self.assertEqual(worker.call_api.call_count, 1)
        self.assertEqual(len({x['requestId'] for x in report['attempts']}), 2)

    def test_all_models_fail_once_and_never_expose_exception_secrets(self):
        worker = self.worker()
        worker.call_api.side_effect = RuntimeError('secret-credential-in-provider-response')
        report, events = self.run_worker(worker, [{'provider': 'fallback', 'model': 'approved'}, {'provider': 'last', 'model': 'last-approved'}])
        self.assertEqual(report['status'], 'model_failed')
        self.assertEqual(worker.call_api.call_count, 3)
        self.assertIn('language', report['unresolved'])
        self.assertNotIn('secret-credential', events + json.dumps(report))

    def test_invalid_response_uses_fallback_without_inventing_language(self):
        worker = self.worker()
        worker.call_api.side_effect = ['{"fields": {}}', worker.call_api.return_value]
        report, _ = self.run_worker(worker, [{'provider': 'fallback', 'model': 'approved'}])
        self.assertEqual(report['attempts'][0]['errorCode'], 'invalid_response')
        self.assertEqual(report['fields']['language']['value'], 'fr')

    def test_no_implicit_fallback_and_configuration_failure_is_distinct(self):
        worker = self.worker()
        worker.get_provider_config.side_effect = RuntimeError('private credential details')
        report, events = self.run_worker(worker)
        self.assertEqual(report['attempts'][0]['errorCode'], 'configuration_failed')
        self.assertEqual(len(report['attempts']), 1)
        worker.call_api.assert_not_called()
        self.assertNotIn('private credential', events)

    def evidence(self):
        return {'pages': 10, 'samples': [{'page': 1}, {'page': 5}], 'outlines': [{'page': 9}]}

    def field(self, value, pages=None):
        return {'value': value, 'confidence': 'high', 'pages': pages or [5], 'reason': 'observed page evidence'}

    def test_reject_unobserved_page_low_confidence_and_invalid_enum(self):
        raw = {'fields': {'language': self.field('en', [7]), 'layout': self.field('invented'), 'book_type': {**self.field('mixed'), 'confidence': 'low'}}}
        self.assertEqual(a.validate_fields(raw, self.evidence())[0], {})

    def test_reject_conflicting_notes_and_reversed_page_range(self):
        raw = {'fields': {'book_type': self.field('no_notes'), 'note_location': self.field('book_end_notes'), 'start_page': self.field(9), 'end_page': self.field(1)}}
        self.assertEqual(a.validate_fields(raw, self.evidence())[0], {})

    def test_valid_evidence_and_no_fabricated_fields(self):
        raw = {'fields': {'language': self.field('fr'), 'note_location': self.field('book_end_notes', [9]), 'confirmed': self.field(True)}}
        fields, _ = a.validate_fields(raw, self.evidence())
        self.assertEqual(fields['language']['value'], 'fr')
        self.assertNotIn('confirmed', fields)
        self.assertNotIn('note_numbering', fields)

    def test_partial_sampling_cannot_certify_no_notes(self):
        evidence = {**self.evidence(), 'type': 'pdf'}
        raw = {'fields': {'book_type': self.field('no_notes'), 'note_location': self.field('none'), 'note_numbering': self.field('continuous')}}
        fields, _ = a.validate_fields(raw, evidence)
        self.assertNotIn('book_type', fields)
        self.assertNotIn('note_location', fields)

    def test_full_sampled_no_notes_accepts_none_or_omitted_note_numbering(self):
        evidence = {'pages': 2, 'samples': [{'page': 1}, {'page': 2}], 'outlines': [], 'type': 'pdf'}
        raw = {'fields': {'book_type': self.field('no_notes', [1, 2]), 'note_location': self.field('none', [1, 2]), 'note_numbering': self.field('none', [1, 2])}}
        fields, issues = a.validate_fields(raw, evidence)
        self.assertEqual(fields['book_type']['value'], 'no_notes')
        self.assertEqual(fields['note_numbering']['value'], 'per_chapter')
        self.assertNotIn('note_numbering', issues)
        raw_omitted = {'fields': {'book_type': self.field('no_notes', [1, 2]), 'note_location': self.field('none', [1, 2])}}
        fields2, issues2 = a.validate_fields(raw_omitted, evidence)
        self.assertEqual(fields2['note_numbering']['value'], 'per_chapter')
        self.assertNotIn('note_numbering', issues2)

    def test_tail_note_range_requires_both_boundaries_and_tail_notes(self):
        raw = {'fields': {'book_type': self.field('footnote_only'), 'note_start_page': self.field(1)}}
        self.assertNotIn('note_start_page', a.validate_fields(raw, self.evidence())[0])
        raw['fields']['book_type'] = self.field('endnote_only')
        self.assertNotIn('note_start_page', a.validate_fields(raw, self.evidence())[0])

    def test_real_pdf_sampling_and_local_only_never_confirms_or_changes_source(self):
        import pymupdf as fitz
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.pdf'
            doc = fitz.open()
            for i in range(20):
                page = doc.new_page()
                page.insert_text((50, 50), 'Notes' if i == 15 else f'Example page {i+1}')
            doc.set_toc([[1, 'Chapter One', 3], [1, 'Notes', 16]])
            doc.save(source); doc.close()
            before = source.read_bytes()
            report = a.analyze(source, root / 'analysis', root, 'unused', 'unused', 'book', local_only=True)
            self.assertIn(16, report['samplePages'])
            self.assertLessEqual(len(report['samplePages']), 8)
            self.assertIn('language', report['unresolved'])
            self.assertNotIn('confirmed', report['fields'])
            self.assertEqual(report['fields']['end_page']['value'], 20)
            self.assertEqual(before, source.read_bytes())

    def test_bibliography_extraction_from_pdf_and_model_validation(self):
        import pymupdf as fitz
        raw = {
            'fields': {
                'document_type': self.field('book', [1]),
                'bibliography': self.field({
                    'kind': 'book',
                    'title': '青年福柯',
                    'original_title': 'Young Foucault',
                    'authors': ['Elisabetta Basso'],
                    'publisher': 'Columbia University Press',
                    'year': '2022',
                    'isbn': '9780231205849',
                }, [1]),
            },
        }
        fields, issues = a.validate_fields(raw, self.evidence())
        self.assertIn('bibliography', fields)
        self.assertNotIn('bibliography', issues)
        self.assertEqual(fields['bibliography']['value']['authors'], 'Elisabetta Basso')
        self.assertEqual(fields['bibliography']['value']['year'], '2022')

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'book.pdf'
            doc = fitz.open()
            doc.set_metadata({'title': 'Test Monograph', 'author': 'Jane Doe'})
            p1 = doc.new_page()
            p1.insert_text((72, 100), 'Test Monograph\nJane Doe\nColumbia University Press')
            p2 = doc.new_page()
            p2.insert_text((72, 100), 'Copyright © 2021 Columbia University Press\nISBN 978-0-231-20584-9\nDOI: 10.1000/xyz123')
            doc.save(source); doc.close()
            report = a.analyze(source, root / 'analysis', root, 'unused', 'unused', 'book', local_only=True)
            bib = report['fields']['bibliography']['value']
            self.assertEqual(bib['authors'], 'Jane Doe')
            self.assertEqual(bib['publisher'], 'Columbia University Press')
            self.assertEqual(bib['year'], '2021')
            self.assertEqual(bib['isbn'], '978-0-231-20584-9')
            self.assertEqual(bib['doi'], '10.1000/xyz123')

    def test_collection_and_incollection_bibliography_preserved(self):
        try:
            import pymupdf as fitz
        except ImportError:
            import fitz
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'edited.pdf'
            doc = fitz.open()
            p1 = doc.new_page()
            p1.insert_text((72, 100), 'Heidegger und die Psychiatrie\nHerausgegeben von Alfred Denker und Holger Zaborowski\nVerlag Karl Alber')
            p2 = doc.new_page()
            p2.insert_text((72, 100), 'Copyright © 2023 Verlag Karl Alber\nISBN 978-3-495-99557-0')
            doc.save(source); doc.close()
            report = a.analyze(source, root / 'analysis', root, 'unused', 'unused', 'book', local_only=True)
            bib = report['fields']['bibliography']['value']
            self.assertEqual(bib['kind'], 'collection')
            self.assertEqual(bib['editors'], 'Alfred Denker; Holger Zaborowski')
            self.assertEqual(bib['publisher'], 'Verlag Karl Alber')
            self.assertEqual(bib['year'], '2023')
            self.assertEqual(bib['isbn'], '978-3-495-99557-0')

            chapter_bib = a.normalize_bibliography({'title': 'Making Up People', 'book_title': 'Historical Ontology', 'authors': 'Ian Hacking'}, default_kind='chapter')
            self.assertEqual(chapter_bib['kind'], 'incollection')
            self.assertEqual(chapter_bib['book_title'], 'Historical Ontology')

if __name__ == '__main__':
    unittest.main()
