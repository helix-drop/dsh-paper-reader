import sys
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import ExitStack

RUNTIME = Path('/Users/hao/Library/Application Support/DSH/PaperReader/.kimi-code/skills/fnm-ai-convert/scripts')
sys.path.insert(0, str(RUNTIME))
import assemble_chapter as chapter
import assemble_book as book
import bounded_chapter as bounded

class PostprocessingTests(unittest.TestCase):
    def test_blank_and_failed_results(self):
        budget = {'used': 3, 'last_failed': True}
        for body in [{'mode':'vision', 'regions':['blank'], 'paragraphs':[]}, {'is_blank':True}, {'blocks':[]}]:
            self.assertFalse(bounded.should_ocr_backfill(body, budget))
        for body in [{}, {'blocks':[], 'error':'invalid response'}, {'blocks':[], 'mode':'ocr_fallback'}]:
            self.assertTrue(bounded.should_ocr_backfill(body, budget))

    def test_ocr_fallback_notes_are_bound_and_later_tampering_is_rejected(self):
        from gate_check import accepted_hashes
        from note_adoption import matches_verified_notes
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'book';root.mkdir()
            note={'anchor':'[^p001_1]','kind':'endnote_num','displayed_number':'1','text':'Verified OCR note.','source_page':1,'anchor_page':None}
            with patch('ocr_rebuild_page.load_raw_pages',return_value={1:{'markdown':'Body text.'}}), patch.object(bounded,'split_body_and_notes',return_value=(['Body text.[^p001_1]'],[note])), patch('ocr_rebuild_page._neighbor_flags',return_value=(False,False,[])):
                bounded.backfill_page_from_ocr(root,'001',1,'transport_failure',root/'output')
            notes=root/'ai_convert/edits/notes/chapter_001.json'
            accepted=accepted_hashes(root)[1]['001']
            self.assertEqual(accepted,bounded.file_hash(notes))
            self.assertTrue(matches_verified_notes(root,'001',accepted))
            data=json.loads(notes.read_text());data['definitions'][0]['text']='unaudited edit';notes.write_text(json.dumps(data))
            self.assertFalse(matches_verified_notes(root,'001',accepted))

    def test_finished_chapter_explicit_retry_only_uses_eligible_affected_budget(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'book'; ai=root/'ai_convert'; ai.mkdir(parents=True)
            folder=Path(tmp)/'delivery';(folder/'output').mkdir(parents=True)
            (ai/'chapters.json').write_text(json.dumps([{'id':'001','start_page':1,'end_page':4}]))
            (ai/'book_analysis.json').write_text(json.dumps({'note_location':'per_page_bottom'}))
            state={'source':str(root.resolve()),'book':str(root.resolve()),'chapter':'001','finished':True,'source_hashes':{},'attempts':{
                '1':{'used':1,'history':[]},'2':{'used':1,'history':[]},'3':{'used':2,'history':[]},'4':{'used':1,'models_exhausted':True,'history':[]}}}
            (folder/'state.json').write_text(json.dumps(state))
            calls=[]
            def worker(book,chapter,task,page,*args):
                calls.append(page)
                raise RuntimeError('fixture transport failure')
            patches=[('conditional_rescue.recover_selection',None),('conditional_rescue.recover_attempt_states',None),
                ('mechanical_repairs.apply',{}),('regional_resolution.inventory',{'page':1,'regions':[]}),('bounded_convert.load_sources',({},[])),
                ('marker_evidence.prescan_policy',False),('native_text_evidence.source_version','fixed')]
            with ExitStack() as stack:
                for name,value in patches:stack.enter_context(patch(name,return_value=value))
                for name,value in [('save_ocr',None),('export_result',{'quality_status':'pending'}),('chapter_checks',['BLOCKED: page 1 fixture']),
                    ('affected_pages',{1,3,4}),('independent_vision_page',True),('backfill_page_from_ocr',None),('create',root)]:
                    stack.enter_context(patch.object(bounded,name,return_value=value))
                bounded.convert_chapter(root,'001',folder,provider='fixture',model='fixture',timeout=1,worker_fn=worker)
                self.assertEqual(calls,[])
                bounded.convert_chapter(root,'001',folder,pages=[1,2,3,4],provider='fixture',model='fixture',timeout=1,worker_fn=worker)
            self.assertEqual(calls,[1])
            after=json.loads((folder/'state.json').read_text())
            self.assertTrue(after['finished'])
            self.assertEqual({k:v['used'] for k,v in after['attempts'].items()},{'1':2,'2':1,'3':2,'4':1})

    def test_chapter_titles_and_notes(self):
        for title, headings, expected in [('2.', ['2.', "Le propre, l’âme et le soi"], '2. Le propre, l’âme et le soi'), ('IV', ['Titre'], 'IV Titre'), ('Titre', ['Section', 'Sous-section'], 'Titre')]:
            with self.subTest(title=title), tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp); ai=root/'ai_convert'
                def write(name, data):
                    p=ai/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(json.dumps(data))
                write('chapters.json',[{'id':'001','title':title,'start_page':1,'end_page':1}])
                write('book_analysis.json',{})
                write('edits/body/page_001.json',{'book_page':1,'paragraphs':[{'pid':f'p001_{i+1}','kind':'subheading_h2','text':text,'markers':[]} for i,text in enumerate(headings)]})
                notes=[{'anchor':f'[^n{i}]','kind':'endnote_num','displayed_number':str(n),'source_page':p,'text':f'note-{p}-{n}'} for i,(p,n) in enumerate([(3,1),(2,10),(2,2)])]
                write('edits/notes/chapter_001.json',{'definitions':notes})
                captured=[]
                original=chapter._render_paragraph
                def capture(para):
                    captured.append(para)
                    return original(para)
                with patch.object(chapter,'verify_chapter',return_value=([],False)),patch.object(chapter,'build_join_ctx',return_value={}),patch.object(chapter,'_render_paragraph',side_effect=capture):
                    ok, errors=chapter.assemble(str(root),'001')
                self.assertTrue(ok,errors)
                md=next((ai/'chapters').glob('*/*.md')).read_text()
                self.assertEqual(book.first_heading(md),expected)
                self.assertLess(md.index('note-2-2'),md.index('note-2-10'))
                self.assertLess(md.index('note-2-10'),md.index('note-3-1'))
                if title=='2.':
                    self.assertEqual(captured[0]['pid_chain'],['p001_1','p001_2'])
                    self.assertEqual(md.count('## 2.'),1)
                if title=='Titre':self.assertIn('## Sous-section',md)

    def test_multiline_part_title_is_preserved_and_allowed_as_divider(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); ai = root / 'ai_convert'
            def write(name, data):
                p = ai / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(json.dumps(data))
            write('chapters.json', [{'id': '002', 'title': 'Cours, année 1981-1982', 'start_page': 9, 'end_page': 10}])
            write('book_analysis.json', {})
            write('edits/body/page_009.json', {'book_page': 9, 'paragraphs': [
                {'pid': 'p009_1', 'kind': 'subheading_h2', 'text': '*Cours*', 'markers': []},
                {'pid': 'p009_2', 'kind': 'subheading_h2', 'text': '*Année 1981-1982*', 'markers': []}]})
            write('edits/body/page_010.json', {'book_page': 10, 'paragraphs': []})
            write('edits/notes/chapter_002.json', {'definitions': []})
            captured = []
            original = chapter._render_paragraph
            with patch.object(chapter, 'verify_chapter', return_value=([], False)), \
                    patch.object(chapter, 'build_join_ctx', return_value={}), \
                    patch.object(chapter, '_render_paragraph', side_effect=lambda para: captured.append(para) or original(para)):
                ok, errors = chapter.assemble(str(root), '002')
            self.assertTrue(ok, errors)
            md = next((ai / 'chapters').glob('*/*.md')).read_text()
            self.assertIn('*Cours*', md)
            self.assertIn('*Année 1981-1982*', md)
            self.assertEqual(captured[0]['pid_chain'], ['p009_1', 'p009_2'])
            blocked, warnings, files = book.book_level_checks(str(root), json.loads((ai / 'chapters.json').read_text()), False)
            self.assertEqual(blocked, [])
            self.assertEqual(len(files), 1)
            self.assertIn('仅含章题', warnings[0])

    def test_leaked_running_header_stripped_and_body_not_swallowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); ai = root / 'ai_convert'
            def write(name, data):
                p = ai / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(json.dumps(data))
            write('chapters.json', [{'id': '006', 'title': 'Faut-il critiquer Foucault ? (suivi du Résumé du débat)', 'start_page': 106, 'end_page': 107}])
            write('book_analysis.json', {'title': 'Penser la folie : essais sur Michel Foucault', 'language': 'fr'})
            write('edits/body/page_106.json', {
                'book_page': 106,
                'paragraphs': [
                    {'pid': 'p106_1', 'kind': 'body', 'text': 'Cela veut dire que je ne suis pas historien et que j\'appartiens aussi à la catégorie de ceux pour', 'continues_to_next': True}
                ]
            })
            write('edits/body/page_107.json', {
                'book_page': 107,
                'paragraphs': [
                    {'pid': 'p107_1', 'kind': 'subheading_h2', 'text': 'Faut-il critiquer Foucault ?', 'continues_from_prev': False},
                    {'pid': 'p107_2', 'kind': 'body', 'text': 'qui le positivisme n\'est pas non plus tout à fait la norme définitive.', 'continues_from_prev': True}
                ]
            })
            write('edits/notes/chapter_006.json', {'definitions': []})
            with patch.object(chapter, 'verify_chapter', return_value=([], False)), patch.object(chapter, 'build_join_ctx', return_value={}):
                ok, errors = chapter.assemble(str(root), '006')
            self.assertTrue(ok, errors)
            md = next((ai / 'chapters').glob('*/*.md')).read_text()
            # Assert leaked running header on page 107 is stripped
            self.assertNotIn('## Faut-il critiquer Foucault ? qui le positivisme', md)
            # Assert paragraphs joined smoothly
            self.assertIn('ceux pour qui le positivisme', md)

    def test_part_title_page_deduped_and_author_converted_to_byline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); ai = root / 'ai_convert'
            def write(name, data):
                p = ai / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(json.dumps(data))
            write('chapters.json', [{'id': '008', 'title': 'Crises de raison, crises de folie ou « la folie » de Foucault', 'start_page': 123, 'end_page': 125}])
            write('book_analysis.json', {'title': 'Penser la folie : essais sur Michel Foucault', 'language': 'fr'})
            # Page 123: Faux-titre leaf with author and all-caps title
            write('edits/body/page_123.json', {
                'book_page': 123,
                'paragraphs': [
                    {'pid': 'p123_1', 'kind': 'subheading_h3', 'text': 'René Major', 'markers': []},
                    {'pid': 'p123_2', 'kind': 'subheading_h2', 'text': 'CRISES DE RAISON\nCRISES DE FOLIE\nOU « LA FOLIE » DE FOUCAULT', 'markers': []}
                ]
            })
            # Page 124: Blank verso
            write('edits/body/page_124.json', {'book_page': 124, 'paragraphs': []})
            # Page 125: Opening page repeating title and body text
            write('edits/body/page_125.json', {
                'book_page': 125,
                'paragraphs': [
                    {'pid': 'p125_1', 'kind': 'subheading_h2', 'text': 'Crises de raison, crises de folie ou « la folie » de Foucault', 'markers': []},
                    {'pid': 'p125_2', 'kind': 'body', 'text': 'Si je déduis que j\'existe du fait que je pense...', 'markers': []}
                ]
            })
            write('edits/notes/chapter_008.json', {'definitions': []})
            with patch.object(chapter, 'verify_chapter', return_value=([], False)), patch.object(chapter, 'build_join_ctx', return_value={}):
                ok, errors = chapter.assemble(str(root), '008')
            self.assertTrue(ok, errors)
            md = next((ai / 'chapters').glob('*/*.md')).read_text()
            # Assert author is rendered as italic byline, not heading
            self.assertIn('*René Major*', md)
            self.assertNotIn('### René Major', md)
            self.assertNotIn('## René Major', md)
            # Assert redundant all-caps faux-titre is removed
            self.assertNotIn('## CRISES DE RAISON', md)
            # Assert chapter title appears exactly once
            self.assertEqual(md.count('## Crises de raison, crises de folie ou « la folie » de Foucault'), 1)

    def test_part_title_with_subtitle_deduped(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); ai = root / 'ai_convert'
            def write(name, data):
                p = ai / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(json.dumps(data))
            write('chapters.json', [{'id': '002', 'title': "Lectures de l'Histoire de la folie (1961-1986). Introduction", 'start_page': 11, 'end_page': 13}])
            write('book_analysis.json', {'title': 'Penser la folie', 'language': 'fr'})
            write('edits/body/page_011.json', {
                'book_page': 11,
                'paragraphs': [
                    {'pid': 'p011_1', 'kind': 'body', 'text': 'Élisabeth Roudinesco', 'markers': []},
                    {'pid': 'p011_2', 'kind': 'subheading_h2', 'text': 'LECTURES DE L’HISTOIRE DE LA FOLIE (1961-1986)', 'markers': []},
                    {'pid': 'p011_3', 'kind': 'subheading_h3', 'text': 'INTRODUCTION', 'markers': []}
                ]
            })
            write('edits/body/page_012.json', {'book_page': 12, 'paragraphs': []})
            write('edits/body/page_013.json', {
                'book_page': 13,
                'paragraphs': [
                    {'pid': 'p013_1', 'kind': 'subheading_h2', 'text': "Lectures de l'*Histoire de la folie* (1961-1986)", 'markers': []},
                    {'pid': 'p013_2', 'kind': 'subheading_h3', 'text': 'Introduction', 'markers': []},
                    {'pid': 'p013_3', 'kind': 'body', 'text': 'Au cours des années qui suivirent...', 'markers': []}
                ]
            })
            write('edits/notes/chapter_002.json', {'definitions': []})
            with patch.object(chapter, 'verify_chapter', return_value=([], False)), patch.object(chapter, 'build_join_ctx', return_value={}):
                ok, errors = chapter.assemble(str(root), '002')
            self.assertTrue(ok, errors)
            md = next((ai / 'chapters').glob('*/*.md')).read_text()
            self.assertIn('*Élisabeth Roudinesco*', md)
            self.assertNotIn('## LECTURES DE L’HISTOIRE', md)
            self.assertEqual(md.count("## Lectures de l'*Histoire de la folie* (1961-1986)"), 1)
            self.assertEqual(md.count('### Introduction'), 1)

    def test_part_title_with_epigraph_and_footnote(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); ai = root / 'ai_convert'
            def write(name, data):
                p = ai / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(json.dumps(data))
            write('chapters.json', [{'id': '007', 'title': 'Histoire de la folie en Italie ou la critique de la psychiatrie', 'start_page': 109, 'end_page': 111}])
            write('book_analysis.json', {'title': 'Penser la folie', 'language': 'fr'})
            write('edits/body/page_109.json', {
                'book_page': 109,
                'paragraphs': [
                    {'pid': 'p109_1', 'kind': 'body', 'text': 'Agostino Pirella', 'markers': []},
                    {'pid': 'p109_2', 'kind': 'subheading_h2', 'text': 'HISTOIRE DE LA FOLIE EN ITALIE OU LA CRITIQUE DE LA PSYCHIATRIE', 'markers': []},
                    {'pid': 'p109_3', 'kind': 'blockquote', 'text': '« Les formes originales de pensée s’introduisent elles-mêmes... »', 'markers': []}
                ]
            })
            write('edits/body/page_110.json', {'book_page': 110, 'paragraphs': []})
            write('edits/body/page_111.json', {
                'book_page': 111,
                'paragraphs': [
                    {'pid': 'p111_1', 'kind': 'subheading_h2', 'text': 'Histoire de la folie en Italie ou la critique de la psychiatrie [^p111_*]', 'markers': [{'anchor': '[^p111_*]', 'kind': 'editor_symbol', 'raw_glyph': '*'}]},
                    {'pid': 'p111_2', 'kind': 'body', 'text': 'En cette période, la psychiatrie traverse une crise...', 'markers': []}
                ]
            })
            write('edits/notes/chapter_007.json', {'definitions': []})
            with patch.object(chapter, 'verify_chapter', return_value=([], False)), patch.object(chapter, 'build_join_ctx', return_value={}):
                ok, errors = chapter.assemble(str(root), '007')
            self.assertTrue(ok, errors)
            md = next((ai / 'chapters').glob('*/*.md')).read_text()
            self.assertIn('*Agostino Pirella*', md)
            self.assertNotIn('## HISTOIRE DE LA FOLIE', md)
            self.assertEqual(md.count('## Histoire de la folie en Italie ou la critique de la psychiatrie [^p111_*]'), 1)
            self.assertIn('> « Les formes originales de pensée', md)

    def test_part_title_with_multi_authors(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); ai = root / 'ai_convert'
            def write(name, data):
                p = ai / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(json.dumps(data))
            write('chapters.json', [{'id': '004', 'title': 'Philippe Pinel et les « concierges »', 'start_page': 45, 'end_page': 47}])
            write('book_analysis.json', {'title': 'Penser la folie', 'language': 'fr'})
            write('edits/body/page_045.json', {
                'book_page': 45,
                'paragraphs': [
                    {'pid': 'p045_1', 'kind': 'body', 'text': 'Jacques Postel', 'markers': []},
                    {'pid': 'p045_2', 'kind': 'body', 'text': 'François Bing', 'markers': []},
                    {'pid': 'p045_3', 'kind': 'subheading_h2', 'text': 'PHILIPPE PINEL ET LES « CONCIERGES »', 'markers': []},
                    {'pid': 'p045_4', 'kind': 'subheading_h3', 'text': 'Introduction', 'markers': []}
                ]
            })
            write('edits/body/page_046.json', {'book_page': 46, 'paragraphs': []})
            write('edits/body/page_047.json', {
                'book_page': 47,
                'paragraphs': [
                    {'pid': 'p047_1', 'kind': 'body', 'text': 'L’Histoire de la folie se termine...', 'markers': []}
                ]
            })
            write('edits/notes/chapter_004.json', {'definitions': []})
            with patch.object(chapter, 'verify_chapter', return_value=([], False)), patch.object(chapter, 'build_join_ctx', return_value={}):
                ok, errors = chapter.assemble(str(root), '004')
            self.assertTrue(ok, errors)
            md = next((ai / 'chapters').glob('*/*.md')).read_text()
            self.assertIn('*Jacques Postel, François Bing*', md)
            self.assertEqual(md.count('## PHILIPPE PINEL ET LES « CONCIERGES »'), 1)

    def test_paratext_skip_allowed_on_front_and_back_edges_without_backfill_or_similarity_block(self):
        import page_json_schema as schema
        import verify_page_json as verifier
        import worker_call as worker
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'book'
            ai = root / 'ai_convert'
            def write(rel, data):
                p = root / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
            write('ai_convert/chapters.json', [{'id': '001', 'title': 'Sample Paper', 'start_page': 1, 'end_page': 4}])
            write('ai_convert/book_analysis.json', {'title': 'Sample Paper', 'document_type': 'paper', 'language': 'en', 'book_type': 'no_notes', 'note_location': 'none'})
            write('raw_pages.json', {'pages': [
                {'bookPage': 1, 'markdown': 'Downloaded from JSTOR. All use subject to terms and conditions. ' * 25},
                {'bookPage': 2, 'markdown': ('Published by University Press. Terms of use boilerplate. ' * 20) + 'Sample Paper. Opening paragraph of the article.'},
                {'bookPage': 3, 'markdown': 'Second page body paragraph with full scholarly prose and analysis.' * 12},
                {'bookPage': 4, 'markdown': 'Other books in this publisher series and subscription advertisement. ' * 25},
            ]})
            p1 = {
                'schema_version': 2, 'book_page': 1, 'chapter_id': '001', 'mode': 'vision',
                'reason_fallback': None, 'regions': ['copyright'], 'paragraphs': [],
                'metadata': {'header_removed': None, 'issues': ['paratext_omitted: JSTOR download cover sheet']},
            }
            schema.normalize_body_page(p1)
            self.assertEqual(p1['regions'], ['paratext'])
            self.assertEqual(p1['paragraph_summary'], {'continues_from_prev': False, 'continues_to_next': False, 'complete_paragraph_count': 0})
            p2 = {
                'schema_version': 2, 'book_page': 2, 'chapter_id': '001', 'mode': 'vision',
                'reason_fallback': None, 'regions': ['paratext', 'body'],
                'paragraphs': [
                    {'pid': 'p002_1', 'kind': 'subheading_h2', 'text': 'Sample Paper', 'markers': [], 'continues_from_prev': False, 'continues_to_next': False},
                    {'pid': 'p002_2', 'kind': 'body', 'text': 'Opening paragraph of the article.', 'markers': [], 'continues_from_prev': False, 'continues_to_next': False},
                ],
                'metadata': {'header_removed': None, 'issues': ['paratext_omitted: publisher terms banner']},
            }
            schema.normalize_body_page(p2)
            p3 = {
                'schema_version': 2, 'book_page': 3, 'chapter_id': '001', 'mode': 'vision',
                'reason_fallback': None, 'regions': ['body'],
                'paragraphs': [
                    {'pid': 'p003_1', 'kind': 'body', 'text': 'Second page body paragraph with full scholarly prose and analysis.' * 12, 'markers': [], 'continues_from_prev': False, 'continues_to_next': False},
                ],
                'metadata': {'header_removed': None, 'issues': []},
            }
            schema.normalize_body_page(p3)
            p4 = {
                'schema_version': 2, 'book_page': 4, 'chapter_id': '001', 'mode': 'vision',
                'reason_fallback': None, 'regions': ['paratext'], 'paragraphs': [],
                'metadata': {'header_removed': None, 'issues': ['paratext_omitted: publisher series catalog']},
            }
            schema.normalize_body_page(p4)
            for pg in (p1, p2, p3, p4):
                write(f"ai_convert/edits/body/page_{pg['book_page']:03d}.json", pg)
            write('ai_convert/edits/notes/chapter_001.json', {'schema_version': 2, 'chapter_id': '001', 'definitions': []})

            # Backfill guard: explained paratext is intentionally empty; unexplained is not.
            budget = {'used': 3, 'last_failed': True}
            self.assertFalse(bounded.should_ocr_backfill(p1, budget))
            self.assertTrue(bounded.should_ocr_backfill({**p1, 'metadata': {'header_removed': None, 'issues': []}}, budget))

            # Worker auditor: no low_coverage or invalid_paratext_skip on allowed edge pages
            ch_def = {'id': '001', 'start_page': 1, 'end_page': 4}
            self.assertEqual(worker._audit_body_page(p1, {}, ch_def, str(root), False, 'none'), [])
            self.assertEqual(worker._audit_body_page(p2, {}, ch_def, str(root), False, 'none'), [])
            self.assertEqual(worker._audit_body_page(p4, {}, ch_def, str(root), True, 'none'), [])

            # Chapter verifier: passes with zero blockers and no similarity_report
            errors, failed = verifier.verify_chapter(str(root), '001')
            blockers = [e for e in errors if 'WARNING' not in e[:40]]
            self.assertEqual(failed, 0, errors)
            self.assertEqual(blockers, [])
            self.assertFalse((ai / 'similarity_report' / 'chapter_001.json').exists())

            # Chapter assembly succeeds and outputs only substantive content
            ok, asm_errors = chapter.assemble(str(root), '001')
            self.assertTrue(ok, asm_errors)
            md = next((ai / 'chapters').glob('*/*.md')).read_text(encoding='utf-8')
            self.assertIn('Opening paragraph of the article.', md)
            self.assertNotIn('JSTOR', md)
            self.assertNotIn('publisher series', md)

    def test_paratext_skip_blocked_in_mid_body_and_interior_chapters(self):
        import page_json_schema as schema
        import verify_page_json as verifier
        import worker_call as worker
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'book'
            def write(rel, data):
                p = root / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
            # Case A: mid-body page in a single-chapter paper
            write('ai_convert/chapters.json', [{'id': '001', 'title': 'Paper', 'start_page': 1, 'end_page': 3}])
            write('ai_convert/book_analysis.json', {'title': 'Paper', 'document_type': 'paper', 'language': 'en', 'book_type': 'no_notes', 'note_location': 'none'})
            p1 = {'schema_version': 2, 'book_page': 1, 'chapter_id': '001', 'mode': 'vision', 'reason_fallback': None, 'regions': ['body'],
                  'paragraphs': [{'pid': 'p001_1', 'kind': 'body', 'text': 'First page text.', 'markers': [], 'continues_from_prev': False, 'continues_to_next': False}],
                  'metadata': {'header_removed': None, 'issues': []}}
            p2 = {'schema_version': 2, 'book_page': 2, 'chapter_id': '001', 'mode': 'vision', 'reason_fallback': None, 'regions': ['paratext'],
                  'paragraphs': [], 'metadata': {'header_removed': None, 'issues': ['paratext_omitted: bogus mid-paper skip']}}
            p3 = {'schema_version': 2, 'book_page': 3, 'chapter_id': '001', 'mode': 'vision', 'reason_fallback': None, 'regions': ['body'],
                  'paragraphs': [{'pid': 'p003_1', 'kind': 'body', 'text': 'Third page text.', 'markers': [], 'continues_from_prev': False, 'continues_to_next': False}],
                  'metadata': {'header_removed': None, 'issues': []}}
            for pg in (p1, p2, p3):
                schema.normalize_body_page(pg)
                write(f"ai_convert/edits/body/page_{pg['book_page']:03d}.json", pg)
            write('ai_convert/edits/notes/chapter_001.json', {'schema_version': 2, 'chapter_id': '001', 'definitions': []})
            errors, _ = verifier.verify_chapter(str(root), '001')
            self.assertTrue(any('BLOCKED' in e and 'paratext' in e for e in errors), errors)

            # Case B: interior chapter in a multi-chapter book blocked at single-page level
            write('ai_convert/chapters.json', [
                {'id': '001', 'title': 'Front Matter', 'start_page': 1, 'end_page': 2},
                {'id': '002', 'title': 'Chapter 1', 'start_page': 3, 'end_page': 5},
                {'id': '003', 'title': 'Back Matter', 'start_page': 6, 'end_page': 7},
            ])
            mid = {'schema_version': 2, 'book_page': 4, 'chapter_id': '002', 'mode': 'vision', 'reason_fallback': None, 'regions': ['paratext'],
                   'paragraphs': [], 'metadata': {'header_removed': None, 'issues': ['paratext_omitted: falsely skipped']}}
            schema.normalize_body_page(mid)
            write('ai_convert/edits/body/page_004.json', mid)
            ok, page_errs = verifier.verify_body_page(str(root / 'ai_convert/edits/body/page_004.json'), '002', book_dir=str(root))
            self.assertFalse(ok)
            self.assertTrue(any('paratext' in e for e in page_errs), page_errs)
            audit_issues = worker._audit_body_page(mid, {}, {'id': '002', 'start_page': 3, 'end_page': 5}, str(root), False, 'none')
            self.assertIn('invalid_paratext_skip', audit_issues)

            # Waiver unblocks when visually verified
            mid['metadata']['issues'].append('paratext_waived: verified insert ad leaf')
            write('ai_convert/edits/body/page_004.json', mid)
            ok_waived, _ = verifier.verify_body_page(str(root / 'ai_convert/edits/body/page_004.json'), '002', book_dir=str(root))
            self.assertTrue(ok_waived)

    def test_paratext_only_front_matter_chapter_skipped_in_book_assembly_and_provenance(self):
        import page_json_schema as schema
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            'assemble_with_provenance',
            Path(__file__).resolve().parents[1] / 'runtime' / 'assemble_with_provenance.py',
        )
        awp = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(awp)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'document'
            def write(rel, data):
                p = root / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
            write('ai_convert/chapters.json', [
                {'id': '001', 'title': 'Front Matter', 'start_page': 1, 'end_page': 2},
                {'id': '002', 'title': 'Chapter One', 'start_page': 3, 'end_page': 3},
            ])
            write('ai_convert/toc.json', [
                {'title': 'Front Matter', 'printed_start': 1, 'target_pdf_page': 1, 'offset': 0, 'role_hint': 'front_matter'},
                {'title': 'Chapter One', 'printed_start': 3, 'target_pdf_page': 3, 'offset': 0, 'role_hint': 'chapter'},
            ])
            write('ai_convert/book_analysis.json', {'title': 'My Book', 'document_type': 'book', 'language': 'en', 'book_type': 'no_notes', 'note_location': 'none'})
            p1 = {'schema_version': 2, 'book_page': 1, 'chapter_id': '001', 'mode': 'vision', 'reason_fallback': None, 'regions': ['paratext'],
                  'paragraphs': [], 'metadata': {'header_removed': None, 'issues': ['paratext_omitted: cover and title page']}}
            p2 = {'schema_version': 2, 'book_page': 2, 'chapter_id': '001', 'mode': 'vision', 'reason_fallback': None, 'regions': ['paratext'],
                  'paragraphs': [], 'metadata': {'header_removed': None, 'issues': ['paratext_omitted: copyright and other books by author']}}
            p3 = {'schema_version': 2, 'book_page': 3, 'chapter_id': '002', 'mode': 'vision', 'reason_fallback': None, 'regions': ['body'],
                  'paragraphs': [
                      {'pid': 'p003_1', 'kind': 'subheading_h2', 'text': 'Chapter One', 'markers': [], 'continues_from_prev': False, 'continues_to_next': False},
                      {'pid': 'p003_2', 'kind': 'body', 'text': 'Actual substantive prose of chapter one that is long enough for book checks to pass cleanly.', 'markers': [], 'continues_from_prev': False, 'continues_to_next': False},
                  ], 'metadata': {'header_removed': None, 'issues': []}}
            for pg in (p1, p2, p3):
                schema.normalize_body_page(pg)
                write(f"ai_convert/edits/body/page_{pg['book_page']:03d}.json", pg)
            write('ai_convert/edits/notes/chapter_001.json', {'schema_version': 2, 'chapter_id': '001', 'definitions': []})
            write('ai_convert/edits/notes/chapter_002.json', {'schema_version': 2, 'chapter_id': '002', 'definitions': []})

            awp.chapter(root.parent, root, '001')
            awp.chapter(root.parent, root, '002')
            ch1_md = next((root / 'ai_convert/chapters').glob('001-*/*.md')).read_text(encoding='utf-8')
            self.assertEqual(ch1_md, '')

            awp.book_map(root.parent, root, title='My Book')
            full_md = (root / 'ai_convert/book/document/document-full.md').read_text(encoding='utf-8')
            self.assertIn('## Chapter One', full_md)
            self.assertIn('Actual substantive prose of chapter one', full_md)
            self.assertNotIn('Front Matter', full_md)
            self.assertNotIn('缺失', full_md)
            prov = json.loads((root / 'ai_convert/book/document/document-full.md.provenance.json').read_text(encoding='utf-8'))
            self.assertEqual(len(prov['spans']), 2)

    def test_dark_cover_empty_ocr_fallback_writes_authorized_blank_receipt_and_prompt_guidance(self):
        import verify_page_json as verifier
        import worker_call as worker
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'book'
            (root / 'ai_convert').mkdir(parents=True)
            (root / 'ai_convert/book_analysis.json').write_text(json.dumps({'language': 'en'}), encoding='utf-8')
            prompt = worker.build_body_prompt([1], '001', str(root), {1: ''}, {}, '', 'none', 'per_chapter: [^N]', vision_only=True)
            self.assertIn('深色/纯色布面书衣', prompt)
            folder = Path(tmp) / 'delivery'
            backup = folder / 'ocr-backup/pages'
            backup.mkdir(parents=True)
            (backup / 'page_001.json').write_text(json.dumps({'selected_text': ''}), encoding='utf-8')
            # Transport failure with empty OCR does NOT fabricate a blank page
            self.assertIsNone(bounded.backfill_page_from_ocr(root, '001', 1, 'transport_failure', folder))
            # Vision unreadable on verified textless dark cover produces an audited blank fallback page
            rebuilt = bounded.backfill_page_from_ocr(
                root, '001', 1, 'vision_unreadable:near-uniform dark cloth cover with no discernible text', folder
            )
            self.assertIsNotNone(rebuilt)
            self.assertEqual(rebuilt['regions'], ['blank'])
            self.assertEqual(rebuilt['paragraphs'], [])
            self.assertTrue(bounded.authorized_fallback_page(root, 1))
            ok, errs = verifier.verify_body_page(str(root / 'ai_convert/edits/body/page_001.json'), '001', book_dir=str(root))
            self.assertTrue(ok, errs)

    def test_verify_chapter_action_pages_ignore_quoted_toc_page_numbers(self):
        import page_json_schema as schema
        import verify_page_json as verifier
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'book'
            def write(rel, data):
                p = root / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
            write('ai_convert/chapters.json', [{'id': '003', 'title': 'Contents', 'start_page': 15, 'end_page': 16}])
            write('ai_convert/book_analysis.json', {'title': 'Sample', 'document_type': 'book', 'language': 'en', 'book_type': 'no_notes', 'note_location': 'none'})
            p15 = {'schema_version': 2, 'book_page': 15, 'chapter_id': '003', 'mode': 'vision', 'reason_fallback': None, 'regions': ['body'],
                   'paragraphs': [{'pid': 'p015_1', 'kind': 'body', 'text': 'Indirect Communication\t90', 'markers': [], 'continues_from_prev': False, 'continues_to_next': False}],
                   'metadata': {'header_removed': None, 'issues': []}}
            p16 = {'schema_version': 2, 'book_page': 16, 'chapter_id': '003', 'mode': 'vision', 'reason_fallback': None, 'regions': ['body'],
                   'paragraphs': [{'pid': 'p016_1', 'kind': 'body', 'text': 'Faith and Melancholy*\tpage 94.', 'markers': [], 'continues_from_prev': False, 'continues_to_next': False}],
                   'metadata': {'header_removed': None, 'issues': []}}
            for pg in (p15, p16):
                schema.normalize_body_page(pg)
                write(f"ai_convert/edits/body/page_{pg['book_page']:03d}.json", pg)
            write('ai_convert/edits/notes/chapter_003.json', {'schema_version': 2, 'chapter_id': '003', 'definitions': []})
            verifier.verify_chapter(str(root), '003')
            actions = json.loads((root / 'ai_convert/actions/chapter_003.json').read_text(encoding='utf-8'))
            self.assertEqual(actions['pages'], [15, 16])

    def test_fallback_authorization_requires_dual_ocr_and_same_model_and_merge_protects_notes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'book'
            (root / 'ai_convert/edits/notes').mkdir(parents=True)
            budget = {
                'used': 2,
                'history': [
                    {
                        'round': 1,
                        'state': 'failed',
                        'error_message': 'vision_unreadable:dark cloth cover',
                        'calls': [{'provider': 'deepseek-official', 'model': 'deepseek-flash', 'state': 'failed'}],
                    },
                    {'round': 2, 'state': 'started'},
                ],
            }
            # No raw_pages_paddle/mineru -> must NOT authorize OCR prompt
            self.assertIsNone(bounded.fallback_authorization(
                budget, 1, book=root, provider='deepseek-official', model='deepseek-flash'
            ))
            (root / 'raw_pages_paddle.json').write_text(json.dumps({'pages': []}), encoding='utf-8')
            # Dual OCR exists, but user switched to a new model -> must run pure vision first
            self.assertIsNone(bounded.fallback_authorization(
                budget, 1, book=root, provider='opencode-go', model='muse-spark-1.3-contributor'
            ))
            # Same model + dual OCR exists -> authorizes Round 2 OCR fallback
            self.assertIsNotNone(bounded.fallback_authorization(
                budget, 1, book=root, provider='deepseek-official', model='deepseek-flash'
            ))
            # Continuity mismatch error_pages extracts both sides of arrow and pids
            self.assertEqual(
                bounded.error_pages('BLOCKED: continuity mismatch at page 30→31: p030_5.continues_to_next=True but p031_1.continues_from_prev=False'),
                {30, 31},
            )
            # merge_attempt must not overwrite newer chapter notes when candidate wrote no notes_sha256 receipt
            newer_notes = json.dumps({'schema_version': 2, 'chapter_id': '005', 'definitions': [{'anchor': '[^p060_1]', 'text': 'Newer'}]})
            stale_notes = json.dumps({'schema_version': 2, 'chapter_id': '005', 'definitions': []})
            (root / 'ai_convert/edits/notes/chapter_005.json').write_text(newer_notes, encoding='utf-8')
            (root / 'ai_convert/worker_audit.jsonl').write_text(
                json.dumps({'task': 'body', 'chapter': '005', 'pages': [60], 'notes_sha256': 'sha60'}) + '\n',
                encoding='utf-8',
            )
            cand = Path(tmp) / 'cand'
            (cand / 'ai_convert/edits/body').mkdir(parents=True)
            (cand / 'ai_convert/edits/notes').mkdir(parents=True)
            (cand / 'ai_convert/edits/body/page_066.json').write_text('{"book_page": 66}', encoding='utf-8')
            (cand / 'ai_convert/edits/notes/chapter_005.json').write_text(stale_notes, encoding='utf-8')
            (cand / 'ai_convert/worker_audit.jsonl').write_text(
                json.dumps({'task': 'bounded_region_repair', 'chapter': '005', 'pages': [66], 'input_policy': 'image_checked_repair_v1'}) + '\n',
                encoding='utf-8',
            )
            bounded.merge_attempt(root, cand, '005', 66)
            self.assertEqual((root / 'ai_convert/edits/notes/chapter_005.json').read_text(encoding='utf-8'), newer_notes)

if __name__ == '__main__':unittest.main()
