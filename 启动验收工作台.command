#!/bin/zsh
set -e
WORKBENCH_ROOT="${0:A:h}"
cd "$WORKBENCH_ROOT"
if ! command -v python3 >/dev/null 2>&1; then
  echo '需要 Python 3.9+ 执行首次准备。安装方法见 README.md。'
  read -r 'WORKBENCH_REPLY?按回车退出'
  exit 1
fi
python3 scripts/prepare_kvv.py
WORKBENCH_PYTHON="$WORKBENCH_ROOT/integrations/.venv/bin/python"
if [[ ! -x "$WORKBENCH_PYTHON" ]]; then
  WORKBENCH_PYTHON="$WORKBENCH_ROOT/Kimi-Vendor-Verifier/.venv/bin/python"
fi
if [[ ! -x "$WORKBENCH_PYTHON" ]]; then
  echo '首次使用正在安装 Python 依赖…'
  if ! command -v uv >/dev/null 2>&1; then
    echo '需要 uv。请先运行：brew install uv'
    read -r 'WORKBENCH_REPLY?按回车退出'
    exit 1
  fi
  uv venv --python 3.13 integrations/.venv
  uv pip install --python integrations/.venv/bin/python -e integrations/Kimi-Vendor-Verifier
  WORKBENCH_PYTHON="$WORKBENCH_ROOT/integrations/.venv/bin/python"
fi
if "$WORKBENCH_PYTHON" - <<'PYRUN'
import json, sys, urllib.request, webbrowser
try:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    data = json.load(opener.open('http://127.0.0.1:8877/api/session', timeout=2))
    if not data.get('ready') or 'kvv_revision' not in data: sys.exit(1)
except Exception:
    sys.exit(1)
webbrowser.open('http://127.0.0.1:8877/')
PYRUN
then
  exit 0
fi
exec "$WORKBENCH_PYTHON" integrations/server.py --open
