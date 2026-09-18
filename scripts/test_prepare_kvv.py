"""Offline bootstrap tests; no GitHub or model API requests are made."""
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import prepare_kvv as subject


class PrepareKvvTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.name = subject.FIXTURES[0]
        self.path = self.root / self.name
        self.path.parent.mkdir(parents=True)
        self.data = b'{"test":"official fixture"}\n'
        self.pointer = subject.Pointer(hashlib.sha256(self.data).hexdigest(), len(self.data))
        self.pointer_bytes = ("version https://git-lfs.github.com/spec/v1\noid sha256:%s\nsize %s\n"
                              % (self.pointer.sha256, self.pointer.size)).encode()

    def run_fixtures(self, check=False):
        return subject.prepare_fixtures(self.root, {self.name: self.pointer}, "a" * 40, check=check)

    def test_check_is_offline_and_preserves_files(self):
        self.path.write_bytes(self.data)
        before = self.path.stat().st_mtime_ns
        with patch.object(subject, "urlopen", side_effect=AssertionError("unexpected network")):
            self.assertEqual(self.run_fixtures(check=True), 0)
            self.assertEqual(self.path.stat().st_mtime_ns, before)
            self.path.write_bytes(self.pointer_bytes)
            with self.assertRaises(subject.PreparationError):
                self.run_fixtures(check=True)
        self.assertEqual(self.path.read_bytes(), self.pointer_bytes)

    def test_changed_fixture_stops_before_downloading(self):
        modified = b"local user modification"
        self.path.write_bytes(modified)
        with patch.object(subject, "urlopen", side_effect=AssertionError("unexpected network")):
            with self.assertRaisesRegex(subject.PreparationError, "本地修改"):
                self.run_fixtures()
        self.assertEqual(self.path.read_bytes(), modified)

    def test_verified_download_resolves_pointer_and_is_idempotent(self):
        self.path.write_bytes(self.pointer_bytes)
        with patch.object(subject, "urlopen", return_value=io.BytesIO(self.data)) as request:
            self.assertEqual(self.run_fixtures(), 1)
            self.assertEqual(self.run_fixtures(), 0)
        self.assertEqual(request.call_count, 1)
        self.assertTrue(request.call_args.args[0].full_url.startswith(
            "https://media.githubusercontent.com/media/MoonshotAI/Kimi-Vendor-Verifier/"))
        self.assertEqual(self.path.read_bytes(), self.data)

    def test_wrong_hash_or_size_does_not_replace_pointer(self):
        for invalid in (b"x" * len(self.data), self.data[:-1], self.data + b"x"):
            with self.subTest(length=len(invalid)):
                self.path.write_bytes(self.pointer_bytes)
                with patch.object(subject, "urlopen", return_value=io.BytesIO(invalid)):
                    with self.assertRaises(subject.PreparationError):
                        self.run_fixtures()
                self.assertEqual(self.path.read_bytes(), self.pointer_bytes)
                self.assertFalse(list(self.path.parent.glob(".kvv-fixture-*")))

    def test_edit_during_download_is_preserved(self):
        self.path.write_bytes(self.pointer_bytes)
        def download(*args):
            self.path.write_bytes(b"edited during download")
            return self.data
        with patch.object(subject, "download_fixture", side_effect=download):
            with self.assertRaisesRegex(subject.PreparationError, "本地修改"):
                self.run_fixtures()
        self.assertEqual(self.path.read_bytes(), b"edited during download")

    def test_git_read_operations_forbid_transports_and_lazy_fetch(self):
        with patch.object(subject.subprocess, "run") as run:
            run.return_value.stdout = b"revision"
            subject.git(self.root, "rev-parse", "HEAD")
        self.assertEqual(run.call_args.kwargs["env"]["GIT_ALLOW_PROTOCOL"], "")
        self.assertEqual(run.call_args.kwargs["env"]["GIT_NO_LAZY_FETCH"], "1")
        self.assertEqual(run.call_args.kwargs["env"]["GIT_LFS_SKIP_SMUDGE"], "1")

    def test_no_install_during_check_and_no_switch_of_existing_checkout(self):
        with patch.object(subject, "git", side_effect=AssertionError("must not invoke Git")):
            with self.assertRaises(subject.PreparationError):
                subject.ensure_checkout(self.root / "absent", subject.OFFICIAL_URL, "a" * 40, check=True)
        with patch.object(subject, "git", side_effect=[str(self.root).encode(), b"b" * 40]) as git:
            with self.assertRaisesRegex(subject.PreparationError, "未切换或覆盖"):
                subject.ensure_checkout(self.root, subject.OFFICIAL_URL, "a" * 40)
        self.assertEqual(git.call_count, 2)
        self.assertTrue(all(call.args[1] == "rev-parse" for call in git.call_args_list))

    def test_source_requires_official_origin_and_full_revision(self):
        source = self.root / "SOURCE.json"
        invalid = ([], {"upstream": 5}, {"upstream": "https://example.com/vendor", "revision": "a" * 40},
                   {"upstream": subject.OFFICIAL_URL, "revision": "66092cf"})
        for value in invalid:
            with self.subTest(value=value):
                source.write_text(json.dumps(value))
                with self.assertRaises(subject.PreparationError):
                    subject.load_source(source)
        source.write_text(json.dumps({"upstream": subject.OFFICIAL_URL, "revision": "a" * 40}))
        self.assertEqual(subject.load_source(source), (subject.OFFICIAL_URL, "a" * 40))


if __name__ == "__main__":
    unittest.main()
