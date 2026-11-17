"""Offline integration tests for the active OCR/transcription runtime."""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

RUNTIME = Path('/Users/hao/Library/Application Support/DSH/PaperReader/.kimi-code/skills/fnm-ai-convert/scripts')
sys.path.insert(0, str(RUNTIME))
spec = importlib.util.spec_from_file_location('ocr_region', Path(__file__).parents[1] / 'runtime/ocr_region.py')
ocr = importlib.util.module_from_spec(spec); spec.loader.exec_module(ocr)
import fitz
from page_json_schema import normalize_body_page
from gate_check import gate_phase0
import conditional_rescue as rescue
import regional_resolution as regional
import worker_call
from marker_evidence import atomic_json, read_json


class HarnessProviderTests(unittest.TestCase):
    def test_worker_uses_live_harness_catalog_without_vendor_aliases(self):
        catalog = {'default': {'provider': 'fixture-new', 'model': 'new-model'}, 'groups': [{'id': 'fixture-new', 'models': [{'id': 'new-model'}]}]}
        with patch.object(worker_call.harness_worker, 'catalog', return_value=catalog):
            self.assertTrue(worker_call.known_provider('fixture-new'))
            cfg = worker_call.get_provider_config('fixture-new', 'new-model')
            self.assertEqual(cfg['wire'], 'dsh_harness')
            self.assertNotIn('api_key', cfg)
            self.assertNotIn('api_base', cfg)
            with self.assertRaises(RuntimeError):
                worker_call.get_provider_config('old-alias', 'new-model')


class RegionOCRTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name); self.pdf = self.root / 'source.pdf'
        with fitz.open() as doc:
            page = doc.new_page(width=200, height=300)
            page.insert_text((10, 30), 'Visible region')
            page.insert_text((110, 250), 'Outside region')
            doc.save(self.pdf)
        self.provider = Mock(DEFAULT_JOB_URL='https://fixture.invalid')
        self.provider.resolve_default_model.return_value = 'fixture'
        self.provider.resolve_token.return_value = 'synthetic'
        self.provider.submit_job.return_value = 'job-fixture'
        self.provider.poll_job.return_value = 'https://fixture.invalid/result'
        self.provider.download_jsonl.side_effect = lambda url, path: Path(path).write_text('{}')
        self.provider.jsonl_to_raw_pages.return_value = [{'markdown':'Visible region'}]

    def call(self, region=None, page=1):
        return ocr.execute(self.pdf, page, region or [0,0,.5,.5], self.root/'ocr', RUNTIME, self.root/'config', 'A specific ambiguous word', self.provider)

    def test_crop_upload_contains_only_selected_pixels_and_reuses(self):
        first = self.call(); second = self.call()
        self.assertFalse(first['reused']); self.assertTrue(second['reused'])
        self.assertEqual(self.provider.submit_job.call_count,1)
        uploaded = self.provider.submit_job.call_args.args[2]
        with fitz.open(uploaded) as doc:
            self.assertEqual(len(doc),1)
            self.assertEqual((doc[0].rect.width,doc[0].rect.height),(100,150))
            self.assertEqual(doc[0].get_text(),'')
        self.assertFalse(first['verified'])
        self.call([0,.5,1,1]); self.assertEqual(self.provider.submit_job.call_count,2)

    def test_poll_failure_resumes_job_without_resubmission(self):
        self.provider.poll_job.side_effect = [TimeoutError(), 'https://fixture.invalid/result']
        with self.assertRaises(TimeoutError): self.call()
        self.call(); self.assertEqual(self.provider.submit_job.call_count,1)
        self.assertEqual(self.provider.poll_job.call_count,2)

    def test_unknown_submission_does_not_risk_duplicate_billing(self):
        self.provider.submit_job.side_effect = TimeoutError()
        with self.assertRaises(TimeoutError): self.call()
        with self.assertRaisesRegex(ValueError,'unknown status'): self.call()
        self.assertEqual(self.provider.submit_job.call_count,1)

    def test_invalid_bounds_and_page_never_submit(self):
        for region in [[1,0,0,1],[0,0,float('nan'),1],[-1,0,1,1]]:
            with self.assertRaises(ValueError): self.call(region)
        with self.assertRaises(ValueError): self.call(page=2)
        self.provider.submit_job.assert_not_called()

    def test_scanned_preparation_checks_image_coverage_without_ocr(self):
        ai=self.root/'ai_convert'; images=ai/'page_images'; images.mkdir(parents=True)
        atomic_json(ai/'ocr-policy.json',{'mode':'on-demand-regions'})
        atomic_json(self.root/'document_profile.json',{'document_type':'paper','confirmed':True})
        atomic_json(ai/'toc.json',[{'role_hint':'chapter','target_pdf_page':1}])
        with fitz.open(self.pdf) as doc: doc[0].get_pixmap().save(images/'page_001.png')
        self.assertFalse([e for e in gate_phase0(str(self.root)) if e.startswith('BLOCKED')])
        (images/'page_001.png').unlink()
        self.assertTrue([e for e in gate_phase0(str(self.root)) if '原页图像' in e])


class ProtocolTests(unittest.TestCase):
    def test_summary_is_derived_before_validation_even_if_model_count_is_wrong(self):
        page={'paragraphs':[{'pid':'p1','kind':'body','text':'one','continues_from_prev':False,'continues_to_next':False}],
              'paragraph_summary':{'complete_paragraph_count':999,'continues_from_prev':True,'continues_to_next':True}}
        normalize_body_page(page)
        self.assertEqual(page['paragraph_summary'],{'complete_paragraph_count':1,'continues_from_prev':False,'continues_to_next':False})

    def test_rescue_plan_has_short_choices_but_retains_host_versions(self):
        offer={'chapter':'001','page':1,'task':'body','input_hashes':{'source':'a'*64},
               'issues':[{'id':'b'*64,'kind':'source_disagreement','expected_sha256':'c'*64}],
               'available_evidence':[{'page':2,'sha256':'d'*64}]}
        wire=rescue.public_options([offer])[0]
        self.assertNotIn('sha256',json.dumps(wire)); self.assertNotIn('input_hashes',wire)
        plan={**wire,'issue_ids':['I1'],'evidence_pages':[2],'reason':'Boundary uncertainty'}
        restored=rescue.materialize_plan(plan,[offer]);self.assertEqual(rescue.validate(restored,[offer]),offer)
        offer['input_hashes']['source']='e'*64
        with self.assertRaisesRegex(ValueError,'stale_rescue_offer'):rescue.materialize_plan(plan,[offer])

    def test_large_local_correction_keeps_source_snapshot_guard_without_model_hash(self):
        body={'paragraphs':[{'pid':'p1','text':'A short fragment.'}]}; notes={'definitions':[]}
        region={'kind':'paragraph','key':'p1','expected_sha256':regional.digest(body['paragraphs'][0])}
        op={'region_id':'R1','action':'replace','value':{'pid':'p1','text':'A recovered full sentence with the previously omitted words.'}}
        result,_=regional.apply_operations(body,notes,[op],{'R1':region},1,set())
        self.assertEqual(result['paragraphs'][0],op['value'])
        body['paragraphs'][0]['text']='Changed while model was running.'
        with self.assertRaisesRegex(ValueError,'stale_region'):regional.apply_operations(body,notes,[op],{'R1':region},1,set())

if __name__=='__main__':unittest.main()
