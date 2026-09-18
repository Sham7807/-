#!/usr/bin/env python3
"""Install the pinned official KVV source and its four API-test LFS fixtures.

Python 3.9+ and Git are sufficient. --check never allows Git transports or HTTP.
Existing checkouts and locally edited fixture files are never reset or replaced.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.error import URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent.parent
SOURCE_FILE = ROOT / "integrations" / "SOURCE.json"
CHECKOUT = ROOT / "integrations" / "Kimi-Vendor-Verifier"
OFFICIAL_URL = "https://github.com/MoonshotAI/Kimi-Vendor-Verifier"
FIXTURES = (
    "testdata/prompt_token_cases/cases.jsonl",
    "testdata/prompt_token_cases/cases.partial.jsonl",
    "testdata/prompt_token_cases/vision_cases.jsonl",
    "testdata/prompt_token_cases/images/vision_fixture.png",
)
MAX_FIXTURE_SIZE = 16 * 1024 * 1024


class PreparationError(Exception):
    """An actionable installation or integrity error."""


@dataclass(frozen=True)
class Pointer:
    sha256: str
    size: int


def load_source(path=SOURCE_FILE):
    try:
        source = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise PreparationError("无法读取 integrations/SOURCE.json：%s" % exc) from exc
    if not isinstance(source, dict):
        raise PreparationError("SOURCE.json 必须是包含 upstream 和 revision 的 JSON 对象。")
    upstream, revision = source.get("upstream", ""), source.get("revision", "")
    if not isinstance(upstream, str) or not isinstance(revision, str):
        raise PreparationError("SOURCE.json 的 upstream 和 revision 必须是字符串。")
    upstream = upstream.rstrip("/")
    if upstream.endswith(".git"):
        upstream = upstream[:-4]
    if upstream != OFFICIAL_URL or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise PreparationError("SOURCE.json 必须指定 MoonshotAI 官方仓库与完整的固定提交 SHA。")
    return upstream, revision


def git(repo, *args, network=False):
    env = os.environ.copy()
    env.update(GIT_LFS_SKIP_SMUDGE="1", GIT_TERMINAL_PROMPT="0",
               GIT_ALLOW_PROTOCOL="https" if network else "",
               GIT_NO_LAZY_FETCH="0" if network else "1")
    # Disable smudge even when git-lfs is unavailable or global filters are set.
    command = ["git", "-c", "filter.lfs.process=", "-c", "filter.lfs.smudge=",
               "-c", "filter.lfs.required=false", "-c", "core.hooksPath=" + os.devnull]
    if repo is not None:
        command += ["-C", str(repo)]
    command += list(args)
    try:
        result = subprocess.run(command, env=env, check=True, capture_output=True, timeout=300)
    except FileNotFoundError as exc:
        raise PreparationError("找不到 Git，请先安装 Git 后重试。") from exc
    except subprocess.TimeoutExpired as exc:
        raise PreparationError("Git 操作超时，请检查到 GitHub 的连接后重试。") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or b"").decode("utf-8", "replace").strip()
        raise PreparationError("Git 操作失败：%s" % detail[-2000:]) from exc
    return result.stdout


def verify_checkout(repo, revision):
    if not repo.is_dir():
        raise PreparationError("KVV 源码尚未安装，请运行 python3 scripts/prepare_kvv.py。")
    toplevel = Path(git(repo, "rev-parse", "--show-toplevel").decode().strip()).resolve()
    if toplevel != repo.resolve():
        raise PreparationError("现有 KVV 目录不是独立 Git checkout；为保留文件，安装已停止。")
    actual = git(repo, "rev-parse", "--verify", "HEAD").decode().strip()
    if actual != revision:
        raise PreparationError("现有 KVV 版本为 %s，要求 %s。未切换或覆盖现有文件；请先自行备份并移走该目录。"
                               % (actual, revision))


def ensure_checkout(repo, upstream, revision, check=False):
    if repo.exists() or repo.is_symlink():
        verify_checkout(repo, revision)
        return
    if check:
        raise PreparationError("KVV 源码尚未安装，请运行 python3 scripts/prepare_kvv.py。")
    repo.parent.mkdir(parents=True, exist_ok=True)
    # A failed clone must not leave an incomplete directory at the final path.
    temporary = Path(tempfile.mkdtemp(prefix=".kvv-prepare-", dir=repo.parent))
    staged = temporary / "checkout"
    try:
        print("正在获取官方 KVV 固定版本 %s…" % revision[:12], flush=True)
        git(None, "clone", "--no-checkout", "--filter=blob:none", "--depth=1",
            upstream + ".git", str(staged), network=True)
        git(staged, "fetch", "--depth=1", "origin", revision, network=True)
        git(staged, "checkout", "--detach", revision, network=True)
        verify_checkout(staged, revision)
        if repo.exists() or repo.is_symlink():
            raise PreparationError("安装期间目标目录已出现；未覆盖该目录，请重试。")
        staged.rename(repo)
    finally:
        shutil.rmtree(temporary)


def parse_pointer(raw):
    try:
        text = raw.decode("ascii").replace("\r\n", "\n")
    except UnicodeError:
        return None
    match = re.fullmatch(r"version https://git-lfs.github.com/spec/v1\n"
                         r"oid sha256:([0-9a-f]{64})\nsize ([0-9]+)\n?", text)
    if not match:
        return None
    return Pointer(match.group(1), int(match.group(2)))


def expected_pointers(repo, revision):
    pointers = {}
    for name in FIXTURES:
        pointer = parse_pointer(git(repo, "show", revision + ":" + name))
        if pointer is None or not 0 < pointer.size <= MAX_FIXTURE_SIZE:
            raise PreparationError("官方提交中的必要测试文件不是有效 LFS pointer：%s" % name)
        pointers[name] = pointer
    return pointers


def fixture_state(path, pointer):
    if path.is_symlink():
        raise PreparationError("测试文件是符号链接，未覆盖：%s" % path)
    if not path.exists():
        return "missing"
    if not path.is_file():
        raise PreparationError("测试文件路径被其他对象占用，未覆盖：%s" % path)
    data = path.read_bytes()
    if len(data) == pointer.size and hashlib.sha256(data).hexdigest() == pointer.sha256:
        return "ready"
    if parse_pointer(data) == pointer:
        return "pointer"
    raise PreparationError("测试文件内容与官方版本不同，可能有本地修改；未覆盖：%s" % path)


def download_fixture(name, pointer, revision):
    url = "https://media.githubusercontent.com/media/MoonshotAI/Kimi-Vendor-Verifier/%s/%s" % (
        revision, quote(name, safe="/"))
    request = Request(url, headers={"User-Agent": "channel-workbench-kvv-prepare/1"})
    data = bytearray()
    try:
        with urlopen(request, timeout=60) as response:
            while True:
                chunk = response.read(min(65536, pointer.size + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > pointer.size:
                    raise PreparationError("下载大小超过官方 pointer，未保存：%s" % name)
    except (OSError, URLError) as exc:
        raise PreparationError("无法下载必要测试数据 %s：%s" % (name, exc)) from exc
    if len(data) != pointer.size or hashlib.sha256(data).hexdigest() != pointer.sha256:
        raise PreparationError("下载数据 SHA-256 或大小校验失败，未保存：%s" % name)
    return bytes(data)


def prepare_fixtures(repo, pointers, revision, check=False):
    states = {}
    for name, pointer in pointers.items():
        path = repo / name
        try:
            path.resolve().relative_to(repo.resolve())
        except ValueError as exc:
            raise PreparationError("测试文件路径指向 KVV 目录以外，未覆盖：%s" % path) from exc
        states[name] = fixture_state(path, pointer)
    pending = [name for name, state in states.items() if state != "ready"]
    if check and pending:
        raise PreparationError("缺少已解析的必要 LFS 数据：%s。请运行 python3 scripts/prepare_kvv.py。"
                               % "、".join(pending))
    for name in pending:
        pointer = pointers[name]
        path = repo / name
        print("下载并校验 %s（%s 字节）" % (name, pointer.size), flush=True)
        data = download_fixture(name, pointer, revision)
        # Recheck after the download so an edit made meanwhile is preserved.
        if fixture_state(path, pointer) == "ready":
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(prefix=".kvv-fixture-", dir=path.parent, delete=False) as output:
                temporary = Path(output.name)
                output.write(data)
            # Avoid replacing locally edited content or a new link while staging.
            if fixture_state(path, pointer) != "ready":
                temporary.replace(path)
        finally:
            if temporary is not None and temporary.exists():
                temporary.unlink()
    return len(pending)


def prepare(check=False, source_file=SOURCE_FILE, checkout=CHECKOUT):
    upstream, revision = load_source(source_file)
    repo = Path(checkout)
    ensure_checkout(repo, upstream, revision, check=check)
    pointers = expected_pointers(repo, revision)
    downloaded = prepare_fixtures(repo, pointers, revision, check=check)
    print("KVV %s 已就绪：4/4 个 API 测试数据通过 SHA-256 与大小校验（%s 字节）。"
          % (revision[:12], sum(pointer.size for pointer in pointers.values())))
    if check:
        print("本次为离线检查，没有联网、下载或更改文件。")
    else:
        print("本次补齐 %s 个数据文件；未下载 BEAM 数据，未发送任何模型 API 请求。" % downloaded)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="仅离线验证源码版本和必要 LFS 数据，不修改文件")
    args = parser.parse_args(argv)
    try:
        prepare(check=args.check)
    except (PreparationError, OSError) as exc:
        print("KVV 准备失败：%s" % exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
