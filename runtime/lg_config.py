#!/usr/bin/env python3
"""DSH-managed LinguaGacha transport. No independent model profiles."""
import json
import subprocess
import sys
from pathlib import Path
from lingua_harness_config import apply_lease, restore_lease


def main():
    args = sys.argv[1:]
    config = Path.home() / 'LinguaGacha/userdata/config.json'
    if args and args[0] == 'harness-begin' and len(args) == 3:
        if subprocess.run(['pgrep', '-xq', 'LinguaGacha'], capture_output=True).returncode == 0:
            raise RuntimeError('LinguaGacha 正在运行，不能更换临时连接')
        apply_lease(config, args[1], args[2])
    elif args and args[0] == 'harness-end' and len(args) == 2:
        restore_lease(config, args[1])
    elif args and args[0] in {'show', 'models', 'public-status'}:
        print(json.dumps({'managedBy': 'DSH', 'message': '模型目录、默认值和凭证由 DSH 管理，请在阅读面板选择'}, ensure_ascii=False))
    else:
        raise RuntimeError('独立模型配置已停用，请在 DSH 阅读面板选择模型')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
