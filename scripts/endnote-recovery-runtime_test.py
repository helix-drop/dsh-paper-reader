"""Regression coverage for accepted notes-only pages and fallback recovery."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

RUNTIME = Path('/Users/hao/Library/Application Support/DSH/PaperReader/.kimi-code/skills/fnm-ai-convert/scripts')
sys.path.insert(0, str(RUNTIME))
import bounded_chapter as bounded
import mechanical_repairs as repairs
import verify_page_json as verify


class EndnoteRecoveryTests(unittest.TestCase):
    def test_notes_only_success_survives_later_failure(self):
        page = {'mode': 'vision', 'regions': ['endnotes'], 'paragraphs': [],
                'notes_definitions': [{'anchor': '[^12]', 'text': 'Original note.'}]}
        for budget in ({'used': 2}, {'used': 3, 'last_failed': True}):
            self.assertFalse(bounded.should_ocr_backfill(page, budget))
        self.assertTrue(bounded.should_ocr_backfill({}, {'used': 2, 'last_failed': True}))

    def test_recovery_uses_selected_fallback_and_checks_its_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            delivery = Path(tmp) / 'chapter_001'
            ai = delivery / 'attempts/page_001_round_1_fallback_1/book/ai_convert'
            body = ai / 'edits/body/page_001.json'
            body.parent.mkdir(parents=True)
            raw = json.dumps({'mode': 'vision', 'paragraphs': [],
                              'notes_definitions': [{'anchor': '[^1]', 'text': 'Note.'}]})
            body.write_text(raw)
            row = {'task': 'body', 'status': 'ok', 'input_policy': 'image_first_no_ocr_v1',
                   'body_hashes': {body.name: hashlib.sha256(raw.encode()).hexdigest()}}
            (ai / 'worker_audit.jsonl').write_text(json.dumps(row) + '\n')
            state = {'attempts': {'1': {'history': [{'round': 1, 'state': 'selected',
                'model_role': 'fallback', 'provider': 'fallback', 'model': 'vision',
                'calls': [{'state': 'failed', 'provider': 'primary', 'model': 'vision'},
                          {'state': 'returned', 'provider': 'fallback', 'model': 'vision'}]}]}}}
            (delivery / 'state.json').write_text(json.dumps(state))
            found = repairs._load_attempt_round(delivery, 1, 1)
            self.assertEqual(found['text'], raw)
            body.write_text(raw.replace('Note.', 'Tampered.'))
            self.assertIsNone(repairs._load_attempt_round(delivery, 1, 1))

    def test_note_comparison_stops_at_spaced_and_ocr_confused_numbers(self):
        for label in ('11.', '1 1 .', 'I l .'):
            text = f'10. Original note. {label} The following note must be excluded.'
            candidates = verify._extract_note_ocr_candidates(text, '10')
            self.assertEqual(candidates, ['10. Original note.'])
        self.assertEqual(verify._extract_note_ocr_candidates('110. Unrelated note.', '10'), [])

    def test_body_paragraph_can_move_to_note_and_leave_notes_only_page(self):
        import note_continuation
        from bounded_chapter import independent_vision_page
        from gate_check import accepted_hashes

        with tempfile.TemporaryDirectory() as tmp:
            book = Path(tmp) / 'chapter_025/selected/book'
            body_dir = book / 'ai_convert/edits/body'
            body_dir.mkdir(parents=True)
            (book / 'ai_convert/edits/notes').mkdir(parents=True)
            (book / 'ai_convert/page_images').mkdir(parents=True)
            (book / 'ai_convert/chapters.json').write_text(json.dumps([
                {'id': '025', 'start_page': 463, 'end_page': 464}]))
            for page in (463, 464):
                (book / f'ai_convert/page_images/page_{page:03d}.png').write_bytes(
                    f'image-{page}'.encode())
            tail = 'sacrée et inviolable; the rest of note 23.'
            body = {'schema_version': 2, 'book_page': 464, 'chapter_id': '025',
                    'mode': 'vision', 'regions': ['header', 'body', 'endnotes'],
                    'paragraphs': [{'pid': 'p464_1', 'kind': 'body', 'text': tail,
                                    'markers': [], 'continues_from_prev': False,
                                    'continues_to_next': False}],
                    'metadata': {'issues': ['previously classified as body']},
                    'paragraph_summary': {'continues_from_prev': False,
                                          'continues_to_next': False,
                                          'complete_paragraph_count': 1}}
            raw = json.dumps(body, ensure_ascii=False, indent=2) + '\n'
            body_path = body_dir / 'page_464.json'
            body_path.write_text(raw)
            notes = {'schema_version': 2, 'chapter_id': '025', 'definitions': [
                {'anchor': '[^23]', 'text': 'Beginning of note 23.', 'source_page': 463}]}
            notes_raw = json.dumps(notes, ensure_ascii=False, indent=2) + '\n'
            notes_path = book / 'ai_convert/edits/notes/chapter_025.json'
            notes_path.write_text(notes_raw)
            audit = book / 'ai_convert/worker_audit.jsonl'
            rows = [
                {'task': 'body', 'status': 'ok', 'chapter': '025', 'pages': [464],
                 'input_policy': 'image_first_no_ocr_v1',
                 'body_hashes': {'page_464.json': hashlib.sha256(raw.encode()).hexdigest()}},
                {'task': 'notes', 'status': 'ok', 'chapter': '025',
                 'notes_sha256': hashlib.sha256(notes_raw.encode()).hexdigest()},
            ]
            audit.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))
            review = {'chapter': '025', 'anchor': '[^23]', 'source_page': 463,
                      'continued_on_page': 464, 'continuation': tail,
                      'body_pids': ['p464_1'], 'status': 'source_checked_not_yet_applied',
                      'basis': 'Viewed pages 463 and 464; the page-top paragraph completes note 23.'}
            row = note_continuation.apply(book, review)
            after = json.loads(body_path.read_text())
            self.assertEqual(after['paragraphs'], [])
            self.assertNotIn('body', after['regions'])
            self.assertEqual(after['paragraph_summary'], {
                'continues_from_prev': False, 'continues_to_next': False,
                'complete_paragraph_count': 0})
            self.assertIn('no body paragraphs remain', after['metadata']['issues'][0])
            self.assertTrue(note_continuation.valid_receipt(
                row, hashlib.sha256(notes_raw.encode()).hexdigest(), book))
            self.assertEqual(accepted_hashes(book)[0]['page_464.json'],
                             hashlib.sha256(body_path.read_bytes()).hexdigest())
            self.assertTrue(independent_vision_page(book, 464))

    def test_source_checked_merge_replace_and_page_patch_replay(self):
        import source_checked_edit
        from bounded_chapter import independent_vision_page
        from gate_check import accepted_hashes

        with tempfile.TemporaryDirectory() as tmp:
            book = Path(tmp) / 'chapter_003/selected/book'
            (book / 'ai_convert/edits/body').mkdir(parents=True)
            (book / 'ai_convert/edits/notes').mkdir(parents=True)
            (book / 'ai_convert/page_images').mkdir(parents=True)
            prefix = 'Le gnosticisme représente un courant ancien.'
            tail = 'Au sens de ce savoir salvateur, initiative et symbolique.'
            rows = []
            for page, text in ((33, prefix), (34, tail)):
                (book / f'ai_convert/page_images/page_{page:03d}.png').write_bytes(
                    f'image-{page}'.encode())
                body = {'book_page': page, 'paragraphs': [], 'notes_definitions': [{
                    'anchor': '[^49]', 'kind': 'endnote_num', 'displayed_number': '49',
                    'text': text, 'source_page': page, 'anchor_page': None}]}
                raw = json.dumps(body, ensure_ascii=False, indent=2) + '\n'
                (book / f'ai_convert/edits/body/page_{page:03d}.json').write_text(raw)
                rows.append({'task': 'body', 'status': 'ok', 'chapter': '003', 'pages': [page],
                             'input_policy': 'image_first_no_ocr_v1',
                             'body_hashes': {f'page_{page:03d}.json': hashlib.sha256(raw.encode()).hexdigest()}})
            notes = {'chapter_id': '003', 'definitions': [{
                'anchor': '[^49]', 'kind': 'endnote_num', 'displayed_number': '49',
                'text': tail, 'source_page': 33, 'anchor_page': None}]}
            notes_raw = json.dumps(notes, ensure_ascii=False, indent=2) + '\n'
            notes_path = book / 'ai_convert/edits/notes/chapter_003.json'
            notes_path.write_text(notes_raw)
            rows.append({'task': 'notes', 'status': 'ok', 'chapter': '003',
                         'notes_sha256': hashlib.sha256(notes_raw.encode()).hexdigest()})
            (book / 'ai_convert/worker_audit.jsonl').write_text(
                ''.join(json.dumps(row) + '\n' for row in rows))
            review = {'chapter': '003', 'type': 'merge_definition', 'anchor': '[^49]',
                      'source_page': 33, 'continued_on_page': 34, 'source_pages': [33, 34],
                      'old': tail, 'merged_text_patch': {'old': 'initiative', 'new': 'initiatique'},
                      'page_patch': {'page': 34, 'anchor': '[^49]',
                                     'old': 'initiative', 'new': 'initiatique'},
                      'status': 'source_checked_not_yet_applied',
                      'basis': 'Viewed pages 33 and 34; merge the fragments and correct the visible word.'}
            source_checked_edit.apply(book, review)
            saved_notes = json.loads(notes_path.read_text())
            saved_body = json.loads((book / 'ai_convert/edits/body/page_034.json').read_text())
            self.assertEqual(saved_notes['definitions'][0]['text'],
                             prefix + ' Au sens de ce savoir salvateur, initiatique et symbolique.')
            self.assertEqual(saved_notes['definitions'][0]['continued_on_page'], 34)
            self.assertEqual(saved_body['notes_definitions'][0]['text'],
                             'Au sens de ce savoir salvateur, initiatique et symbolique.')
            self.assertEqual(accepted_hashes(book)[1]['003'],
                             hashlib.sha256(notes_path.read_bytes()).hexdigest())
            self.assertTrue(independent_vision_page(book, 34))
            source_checked_edit.apply(book, {
                'chapter': '003', 'type': 'patch', 'anchor': '[^49]', 'source_page': 34,
                'old': 'Au sens', 'new': 'Dans le sens',
                'page_patch': {'page': 34, 'anchor': '[^49]',
                               'old': 'Au sens', 'new': 'Dans le sens'},
                'status': 'source_checked_not_yet_applied',
                'basis': 'A second reviewed edit to the same page must preserve the full receipt chain.'})
            self.assertTrue(independent_vision_page(book, 34))

    def test_source_checked_insert_patch_and_replace_definition(self):
        import source_checked_edit
        from gate_check import accepted_hashes

        with tempfile.TemporaryDirectory() as tmp:
            book = Path(tmp) / 'chapter_007/selected/book'
            (book / 'ai_convert/edits/body').mkdir(parents=True)
            (book / 'ai_convert/edits/notes').mkdir(parents=True)
            (book / 'ai_convert/page_images').mkdir(parents=True)
            rows = []
            fragments = {109: 'Beginning (*ontôs philosophein*) mais',
                         110: "de l'être vraiment (kat'alētheian hugiainein)."}
            for page, text in fragments.items():
                (book / f'ai_convert/page_images/page_{page:03d}.png').write_bytes(
                    f'image-{page}'.encode())
                body = {'book_page': page, 'paragraphs': [], 'notes_definitions': [{
                    'anchor': '[^53]', 'kind': 'endnote_num', 'displayed_number': '53',
                    'text': text, 'source_page': page, 'anchor_page': None}]}
                raw = json.dumps(body, ensure_ascii=False, indent=2) + '\n'
                (book / f'ai_convert/edits/body/page_{page:03d}.json').write_text(raw)
                rows.append({'task': 'body', 'status': 'ok', 'chapter': '007', 'pages': [page],
                             'input_policy': 'image_first_no_ocr_v1',
                             'body_hashes': {f'page_{page:03d}.json': hashlib.sha256(raw.encode()).hexdigest()}})
            definitions = [
                {'anchor': '[^52]', 'text': 'old and old', 'source_page': 109},
                {'anchor': '[^54]', 'text': 'Replace me.', 'source_page': 110},
            ]
            notes_path = book / 'ai_convert/edits/notes/chapter_007.json'
            notes_raw = json.dumps({'chapter_id': '007', 'definitions': definitions},
                                   ensure_ascii=False, indent=2) + '\n'
            notes_path.write_text(notes_raw)
            rows.append({'task': 'notes', 'status': 'ok', 'chapter': '007',
                         'notes_sha256': hashlib.sha256(notes_raw.encode()).hexdigest()})
            (book / 'ai_convert/worker_audit.jsonl').write_text(
                ''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))
            source_checked_edit.apply(book, {
                'chapter': '007', 'type': 'merge_definition', 'anchor': '[^53]',
                'source_page': 109, 'continued_on_page': 110, 'source_pages': [109, 110],
                'old': None, 'status': 'source_checked_not_yet_applied',
                'basis': 'Viewed pages 109 and 110; combine the two accepted fragments.'})
            source_checked_edit.apply(book, {
                'chapter': '007', 'type': 'patch', 'anchor': '[^52]', 'source_page': 109,
                'old': 'old', 'new': 'new', 'status': 'source_checked_not_yet_applied',
                'basis': 'Viewed page 109; correct both occurrences only within note 52.'})
            source_checked_edit.apply(book, {
                'chapter': '007', 'type': 'replace_definition', 'anchor': '[^54]',
                'source_page': 110, 'old': 'Replace me.', 'new': 'Replaced.',
                'status': 'source_checked_not_yet_applied',
                'basis': 'Viewed page 110; replace the exact reviewed definition.'})
            saved = json.loads(notes_path.read_text())['definitions']
            self.assertEqual([d['anchor'] for d in saved], ['[^52]', '[^53]', '[^54]'])
            self.assertEqual(saved[0]['text'], 'new and new')
            self.assertEqual(saved[1]['text'], fragments[109] + ' ' + fragments[110])
            self.assertEqual(saved[1]['continued_on_page'], 110)
            self.assertEqual(saved[2]['text'], 'Replaced.')
            self.assertEqual(accepted_hashes(book)[1]['007'],
                             hashlib.sha256(notes_path.read_bytes()).hexdigest())

    def test_source_checked_remove_unreferenced_page_definition(self):
        import source_checked_edit
        from bounded_chapter import independent_vision_page

        with tempfile.TemporaryDirectory() as tmp:
            book = Path(tmp) / 'chapter_023/selected/book'
            (book / 'ai_convert/edits/body').mkdir(parents=True)
            (book / 'ai_convert/edits/notes').mkdir(parents=True)
            (book / 'ai_convert/page_images').mkdir(parents=True)
            for page in (423, 424):
                (book / f'ai_convert/page_images/page_{page:03d}.png').write_bytes(
                    f'image-{page}'.encode())
            duplicate = {'anchor': '[^7]', 'text': 'Unnumbered continuation.',
                         'source_page': 424, 'anchor_page': None}
            body = {'book_page': 424, 'paragraphs': [],
                    'notes_definitions': [duplicate, {'anchor': '[^8]', 'text': 'Keep.'}]}
            raw = json.dumps(body, ensure_ascii=False, indent=2) + '\n'
            body_path = book / 'ai_convert/edits/body/page_424.json'
            body_path.write_text(raw)
            (book / 'ai_convert/worker_audit.jsonl').write_text(json.dumps({
                'task': 'body', 'status': 'ok', 'chapter': '023', 'pages': [424],
                'input_policy': 'image_first_no_ocr_v1',
                'body_hashes': {'page_424.json': hashlib.sha256(raw.encode()).hexdigest()}}) + '\n')
            source_checked_edit.apply(book, {
                'chapter': '023', 'type': 'remove_page_definition', 'anchor': '[^7]',
                'source_page': 423, 'continued_on_page': 424, 'page': 424,
                'text': 'Unnumbered continuation.', 'status': 'source_checked_not_yet_applied',
                'basis': 'Viewed pages 423 and 424; the duplicate is the unnumbered continuation.'})
            self.assertEqual([d['anchor'] for d in json.loads(body_path.read_text())['notes_definitions']],
                             ['[^8]'])
            self.assertTrue(independent_vision_page(book, 424))

    def test_source_checked_marker_correction_updates_text_and_glyph(self):
        import source_checked_edit
        from bounded_chapter import independent_vision_page

        with tempfile.TemporaryDirectory() as tmp:
            book = Path(tmp) / 'chapter_013/selected/book'
            (book / 'ai_convert/edits/body').mkdir(parents=True)
            (book / 'ai_convert/edits/notes').mkdir(parents=True)
            (book / 'ai_convert/page_images').mkdir(parents=True)
            (book / 'ai_convert/page_images/page_217.png').write_bytes(b'image-217')
            body = {'book_page': 217, 'paragraphs': [{
                'pid': 'p217_2', 'kind': 'body', 'text': 'regard platonicien[^4]. Et la question',
                'markers': [{'anchor': '[^4]', 'kind': 'endnote_num', 'raw_glyph': '⁴'}],
                'continues_from_prev': False, 'continues_to_next': True}]}
            raw = json.dumps(body, ensure_ascii=False, indent=2) + '\n'
            body_path = book / 'ai_convert/edits/body/page_217.json'
            body_path.write_text(raw)
            (book / 'ai_convert/worker_audit.jsonl').write_text(json.dumps({
                'task': 'body', 'status': 'ok', 'chapter': '013', 'pages': [217],
                'input_policy': 'image_first_no_ocr_v1',
                'body_hashes': {'page_217.json': hashlib.sha256(raw.encode()).hexdigest()}}) + '\n')
            source_checked_edit.apply(book, {
                'chapter': '013', 'type': 'marker_correction', 'page': 217,
                'source_page': 217, 'pid': 'p217_2', 'old': 'platonicien[^4]',
                'new': 'platonicien[^41]', 'old_anchor': '[^4]', 'new_anchor': '[^41]',
                'old_raw_glyph': '⁴', 'new_raw_glyph': '⁴¹',
                'status': 'source_checked_not_yet_applied',
                'basis': 'Viewed page 217; the printed superscript is 41, not 4.'})
            paragraph = json.loads(body_path.read_text())['paragraphs'][0]
            self.assertIn('platonicien[^41]', paragraph['text'])
            self.assertEqual(paragraph['markers'][0]['anchor'], '[^41]')
            self.assertEqual(paragraph['markers'][0]['raw_glyph'], '⁴¹')
            self.assertTrue(independent_vision_page(book, 217))
            source_checked_edit.apply(book, {
                'chapter': '013', 'type': 'body_text_patch', 'page': 217,
                'source_page': 217, 'pid': 'p217_2', 'old': 'la question', 'new': 'la réponse',
                'status': 'source_checked_not_yet_applied',
                'basis': 'A reviewed single-paragraph text correction after the marker repair.'})
            paragraph = json.loads(body_path.read_text())['paragraphs'][0]
            self.assertIn('la réponse', paragraph['text'])
            self.assertTrue(independent_vision_page(book, 217))

    def test_source_checked_missed_marker_insertion_and_unaudited_split_notes(self):
        import source_checked_edit
        from bounded_chapter import independent_vision_page
        from gate_check import accepted_hashes

        with tempfile.TemporaryDirectory() as tmp:
            book = Path(tmp) / 'chapter_001/selected/book'
            (book / 'ai_convert/edits/body').mkdir(parents=True)
            (book / 'ai_convert/edits/notes').mkdir(parents=True)
            (book / 'ai_convert/page_images').mkdir(parents=True)
            for page in (2, 310, 311):
                (book / f'ai_convert/page_images/page_{page:03d}.png').write_bytes(
                    f'image-{page}'.encode())
            body = {'book_page': 2, 'paragraphs': [{
                'pid': 'p002_3', 'kind': 'body',
                'text': 'in human societies (1). At the moment',
                'markers': [], 'continues_from_prev': False, 'continues_to_next': False}]}
            raw = json.dumps(body, ensure_ascii=False, indent=2) + '\n'
            body_path = book / 'ai_convert/edits/body/page_002.json'
            body_path.write_text(raw)
            (book / 'ai_convert/worker_audit.jsonl').write_text(json.dumps({
                'task': 'body', 'status': 'ok', 'chapter': '001', 'pages': [2],
                'input_policy': 'image_first_no_ocr_v1',
                'body_hashes': {'page_002.json': hashlib.sha256(raw.encode()).hexdigest()}}) + '\n')
            source_checked_edit.apply(book, {
                'chapter': '001', 'type': 'marker_correction', 'page': 2, 'source_page': 2,
                'pid': 'p002_3', 'old': 'human societies (1).', 'new': 'human societies[^1].',
                'old_anchor': None, 'old_raw_glyph': None,
                'new_anchor': '[^1]', 'new_kind': 'endnote_num', 'new_raw_glyph': '(1)',
                'status': 'source_checked_not_yet_applied',
                'basis': 'Viewed page 2; (1) matches bottom footnote (1).'})
            para = json.loads(body_path.read_text())['paragraphs'][0]
            self.assertEqual(para['text'], 'in human societies[^1]. At the moment')
            self.assertEqual(para['markers'], [{'anchor': '[^1]', 'kind': 'endnote_num', 'raw_glyph': '(1)'}])
            self.assertTrue(independent_vision_page(book, 2))

            notes_path = book / 'ai_convert/edits/notes/chapter_001.json'
            notes_path.write_text(json.dumps({
                'schema_version': 2, 'chapter_id': '001',
                'definitions': [{'anchor': '[^1]', 'kind': 'endnote_num', 'displayed_number': '1',
                                 'text': 'Göttingen: Vandenhoek & Ru', 'source_page': 310}],
                'issues': []}, ensure_ascii=False, indent=2) + '\n')
            source_checked_edit.apply(book, {
                'chapter': '001', 'type': 'patch', 'anchor': '[^1]',
                'source_page': 310, 'continued_on_page': 311,
                'old': 'Vandenhoek & Ru', 'new': 'Vandenhoek & Ruprecht, 1960).',
                'status': 'source_checked_not_yet_applied',
                'basis': 'Viewed pages 310 and 311; complete split endnote.'})
            saved_def = json.loads(notes_path.read_text())['definitions'][0]
            self.assertEqual(saved_def['continued_on_page'], 311)
            self.assertEqual(accepted_hashes(book)[1]['001'],
                             hashlib.sha256(notes_path.read_bytes()).hexdigest())


if __name__ == '__main__':
    unittest.main()
