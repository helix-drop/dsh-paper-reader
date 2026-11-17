"""Short-lived LinguaGacha wire configuration, derived from one DSH selection."""
import hashlib
import json
import os
from pathlib import Path


def apply_lease(config_path, payload_path, receipt_path):
    config_path, receipt_path = Path(config_path), Path(receipt_path)
    recover_leases(config_path, receipt_path.parent)
    before = config_path.read_bytes()
    cfg = json.loads(before)
    p = json.loads(Path(payload_path).read_text())
    model = {'id': 'dsh-harness', 'name': p['model'], 'type': 'CUSTOM_OPENAI', 'api_format': 'OpenAI', 'api_url': p['url'] + '/v1', 'api_key': p['token'], 'model_id': p['model'],
             'agent': {'context_window': p.get('contextWindow', 1048576), 'max_output_tokens': p.get('maxTokens', 131072)},
             'threshold': {'input_token_limit': p.get('inputTokens', p.get('input_token_limit', 800)), 'output_token_limit': p.get('maxTokens', 131072), 'rpm_limit': 0, 'concurrency_limit': p.get('concurrency', 4)},
             'thinking': {'level': 'OFF'}, 'generation': {}, 'request': {}}
    cfg['models'] = [model]
    cfg['model_selection'] = {'translation': 'dsh-harness'}
    cfg['clean_ruby'] = False
    cfg['prompt_enhancement_enable'] = False
    cfg['request_timeout'] = 660
    data = json.dumps(cfg, ensure_ascii=False, indent=2).encode()
    receipt_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with os.fdopen(os.open(receipt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as receipt:
        json.dump({'ownerPid': p['ownerPid'], 'before': before.decode(), 'beforeHash': hashlib.sha256(before).hexdigest(), 'appliedHash': hashlib.sha256(data).hexdigest()}, receipt)
    temp = config_path.with_suffix('.dsh.tmp')
    temp.write_bytes(data); temp.chmod(0o600); os.replace(temp, config_path)


def restore_lease(config_path, receipt_path):
    config_path, receipt_path = Path(config_path), Path(receipt_path)
    record = json.loads(receipt_path.read_text())
    current_hash = hashlib.sha256(config_path.read_bytes()).hexdigest()
    if current_hash == record.get('beforeHash'):
        receipt_path.unlink()
        return
    if current_hash != record['appliedHash']:
        raise RuntimeError('LinguaGacha 配置在执行期间变化，保留恢复副本，不覆盖修改')
    temp = config_path.with_suffix('.dsh.tmp')
    temp.write_text(record['before']); temp.chmod(0o600); os.replace(temp, config_path)
    receipt_path.unlink()


def recover_leases(config_path, directory):
    for receipt in Path(directory).glob('*.restore.json'):
        record = json.loads(receipt.read_text())
        try:
            os.kill(record['ownerPid'], 0)
        except ProcessLookupError:
            restore_lease(config_path, receipt)
        else:
            raise RuntimeError('另一个 DSH 翻译进程仍持有临时配置')
