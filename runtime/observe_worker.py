"""Observe the existing worker entry without changing requests, retries or budgets."""
import json
import runpy
import sys
import threading
import uuid
from pathlib import Path

script, *arguments = sys.argv[1:]
sys.path.insert(0, str(Path(script).resolve().parent))
import worker_call

original = worker_call.call_api
lock = threading.Lock()


def emit(event, **data):
    with lock:
        sys.stdout.write(json.dumps({'type': 'paper-reader-worker', 'event': event, **data}, ensure_ascii=False) + '\n')
        sys.stdout.flush()


def observed(config, prompt, images):
    identity = str(uuid.uuid4())
    model = str(config.get('model', 'unknown'))
    emit('request_started', requestId=identity, model=model, images=[Path(p).name for p in images], prompt=str(prompt)[:4000])
    try:
        result = original(config, prompt, images)
    except Exception as error:
        emit('request_failed', requestId=identity, model=model, errorType=type(error).__name__, errorCode=getattr(error, 'code', None), errorMessage=getattr(error, 'safe_message', None))
        raise
    emit('response_received', requestId=identity, model=model, response=str(result)[:16000], responseCharacters=len(str(result)))
    return result


worker_call.call_api = observed
sys.argv = [script, *arguments]
runpy.run_path(script, run_name='__main__')
