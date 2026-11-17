"""Transport projection of the live DSH catalog; no vendor table or credentials."""
import base64
import json
import os
import urllib.request
from collections.abc import Mapping
from pathlib import Path


class HarnessRequestError(RuntimeError):
    def __init__(self, failure):
        self.code = failure.get('code', 'HARNESS_REQUEST_FAILED')
        self.status = failure.get('status')
        self.safe_message = failure.get('message') or 'DSH 模型请求失败'
        super().__init__(self.code + ': ' + self.safe_message)


def request(route, payload=None, timeout=30):
    url = os.environ.get('DSH_MODEL_GATEWAY', '')
    token = os.environ.get('DSH_MODEL_TOKEN', '')
    if not url.startswith('http://127.0.0.1:') or not token:
        raise RuntimeError('DSH_MODEL_SERVICE_UNAVAILABLE: 请从 DSH 阅读插件启动')
    req = urllib.request.Request(url + route, data=None if payload is None else json.dumps(payload).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            failure = json.loads(error.read()).get('error', {})
        except Exception:
            failure = {'code': 'HARNESS_REQUEST_FAILED'}
        raise HarnessRequestError(failure) from None


def catalog():
    return request('/catalog')


def known_provider(name):
    return any(g['id'] == name for g in catalog()['groups'])


def get_provider_config(provider, model=None):
    c = catalog()
    default = c.get('default', {})
    model = model or (default.get('model') if default.get('provider') == provider else None)
    group = next((g for g in c['groups'] if g['id'] == provider), None)
    if not group or not any(m['id'] == model for m in group['models']):
        raise RuntimeError('MODEL_NOT_AVAILABLE: 模型不在 DSH 当前目录中')
    return {'provider': provider, 'model': model, 'default_model': model, 'wire': 'dsh_harness', 'bounded_attempt': True, 'bounded_workflow': True, 'batch_size': 1, 'request_timeout': 600, 'request_deadline': 600}


def call_api(cfg, prompt, images):
    if cfg.get('wire') != 'dsh_harness':
        raise RuntimeError('DSH_MODEL_SERVICE_REQUIRED')
    payload = {'provider': cfg['provider'], 'model': cfg['model'], 'prompt': prompt, 'images': [{'name': Path(p).name, 'mediaType': 'image/png', 'data': base64.b64encode(Path(p).read_bytes()).decode()} for p in images], 'timeout': cfg.get('request_deadline', 600)}
    if cfg.get('max_tokens'):
        payload['max_tokens'] = cfg['max_tokens']
    return request('/call', payload, timeout=payload['timeout'] + 15)['text']


class CatalogProviders(Mapping):
    """Compatibility view for old controllers, computed from Harness each time."""
    def __iter__(self):
        return iter(g['id'] for g in catalog()['groups'])

    def __len__(self):
        return len(catalog()['groups'])

    def __getitem__(self, name):
        c = catalog()
        if not any(g['id'] == name for g in c['groups']):
            raise KeyError(name)
        default = c.get('default', {})
        return {'default_model': default.get('model', '') if default.get('provider') == name else '', 'batch_size': 1, 'request_deadline': 600}
