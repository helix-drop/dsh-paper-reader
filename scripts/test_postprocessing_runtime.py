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

if __name__ == '__main__':unittest.main()
