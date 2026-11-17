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

if __name__ == '__main__':
    unittest.main()
