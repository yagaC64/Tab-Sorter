"""Bounded native host tests; editor-launch mocks do not establish GUI acceptance."""

import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("tab_sorter_native_host", ROOT / "native" / "host.py")
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)
ORIGIN = "chrome-extension://" + "a" * 32 + "/"


def request(**changes):
    data = {"action": "export", "filename": "tabs-2026-09-15_Work.md", "markdown": "# Tabs\n\n- [Español ☀️](https://example.test)\n", "editor": "notepad-aurora"}
    data.update(changes)
    return data


def frame(value):
    payload = json.dumps(value).encode("utf-8")
    return struct.pack("=I", len(payload)) + payload


def decode_frame(value):
    length = struct.unpack("=I", value[:4])[0]
    assert len(value) == length + 4, "Host wrote unexpected bytes to stdout"
    return json.loads(value[4:].decode("utf-8"))


class NativeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="tab-sorter-native-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.directory = self.base / "snapshots"
        self.patch = mock.patch.object(host, "export_directory", return_value=self.directory)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_private_unicode_snapshot_and_collision_preserve_original(self):
        with mock.patch.object(host, "open_editor") as opened:
            first = host.process_request(request())
            second = host.process_request(request(markdown="second"))
        self.assertTrue(first["ok"])
        self.assertTrue(second["ok"])
        self.assertNotEqual(first["path"], second["path"])
        self.assertEqual(Path(first["path"]).read_text(), request()["markdown"])
        self.assertEqual(Path(second["path"]).read_text(), "second")
        self.assertEqual(Path(first["path"]).stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual(opened.call_count, 2)

    def test_invalid_requests_never_create_snapshot(self):
        bad = [request(filename="../escape.md"), request(filename="/tmp/escape.md"), request(filename="bad\\name.md"), request(filename="bad\nname.md"), request(filename="snapshot.sh"), request(filename="-argument.md"), request(filename="a" * 180 + ".md"), request(action="open"), request(editor="arbitrary.app"), request(markdown=[]), {**request(), "path": "/tmp/arbitrary.md"}, [], request(filename="a..b.md")]
        with mock.patch.object(host, "open_editor") as opened:
            for data in bad:
                with self.subTest(data=data):
                    result = host.process_request(data)
                    self.assertFalse(result["ok"])
                    self.assertIsNone(result["path"])
        self.assertFalse(self.directory.exists())
        opened.assert_not_called()

    def test_editor_failure_retains_saved_snapshot(self):
        with mock.patch.object(host, "open_editor", side_effect=subprocess.CalledProcessError(1, "/usr/bin/open")):
            result = host.process_request(request())
        self.assertFalse(result["ok"])
        self.assertFalse(result["opened"])
        self.assertEqual(Path(result["path"]).read_text(), request()["markdown"])
        self.assertIn("Snapshot saved", result["error"])

    def test_write_failure_does_not_launch_editor(self):
        self.directory.write_text("occupied")
        with mock.patch.object(host, "open_editor") as opened:
            result = host.process_request(request())
        self.assertFalse(result["ok"])
        self.assertIsNone(result["path"])
        opened.assert_not_called()
        self.assertEqual(self.directory.read_text(), "occupied")

    def test_symlink_folder_rejected_and_existing_symlink_not_overwritten(self):
        elsewhere = self.base / "elsewhere"
        elsewhere.mkdir()
        self.directory.symlink_to(elsewhere, target_is_directory=True)
        result = host.process_request(request())
        self.assertFalse(result["ok"])
        self.assertEqual(list(elsewhere.iterdir()), [])
        self.directory.unlink()
        self.directory.mkdir()
        protected = elsewhere / "original.md"
        protected.write_text("original")
        (self.directory / request()["filename"]).symlink_to(protected)
        with mock.patch.object(host, "open_editor"):
            result = host.process_request(request())
        self.assertTrue(result["ok"])
        self.assertEqual(protected.read_text(), "original")

    def test_open_uses_fixed_arguments_without_shell(self):
        path = self.directory / "literal (2).md"
        with mock.patch.object(host.subprocess, "run") as run:
            host.open_editor(path, "notepad-aurora")
            self.assertEqual(run.call_args.args[0], ["/usr/bin/open", "-a", "/Applications/NotepadAurora.app", str(path)])
            self.assertNotIn("shell", run.call_args.kwargs)
            host.open_editor(path, "default")
            self.assertEqual(run.call_args.args[0], ["/usr/bin/open", str(path)])

    def test_framing_rejects_oversize_truncated_and_non_json(self):
        for data in (struct.pack("=I", host.MAX_MESSAGE_BYTES + 1), b"\x00", struct.pack("=I", 3) + b"{}", struct.pack("=I", 1) + b"x"):
            with self.subTest(data=data), self.assertRaises(ValueError):
                host.read_message(io.BytesIO(data))

    def host_process(self, payload, origin=ORIGIN, mock_open=False, config=None):
        copy = self.base / "host.py"
        shutil.copyfile(ROOT / "native" / "host.py", copy)
        if config is None:
            config = {"host": host.HOST_NAME, "allowed_origin": ORIGIN}
        (self.base / "host-config.json").write_text(json.dumps(config))
        if mock_open:
            script = "import sys; sys.path.insert(0, sys.argv.pop(1)); import host; host.open_editor = lambda path, editor: None; host.main()"
            command = [sys.executable, "-c", script, str(self.base), origin]
        else:
            command = [sys.executable, str(copy), origin]
        response = subprocess.run(command, input=payload, capture_output=True, timeout=10, env={**os.environ, "HOME": str(self.base), "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(response.returncode, 0, response.stderr.decode())
        self.assertEqual(response.stderr, b"")
        return decode_frame(response.stdout)

    def test_subprocess_real_framing_saves_in_isolated_home(self):
        result = self.host_process(frame(request()), mock_open=True)
        self.assertTrue(result["ok"])
        target = self.base / "Documents" / "Tab Sorter Snapshots" / request()["filename"]
        self.assertEqual(Path(result["path"]), target)
        self.assertEqual(target.read_text(), request()["markdown"])

    def test_subprocess_wrong_origin_and_oversize_rejected(self):
        wrong = self.host_process(frame(request()), origin="chrome-extension://" + "b" * 32 + "/")
        self.assertFalse(wrong["ok"])
        self.assertIn("not authorized", wrong["error"])
        oversized = self.host_process(struct.pack("=I", host.MAX_MESSAGE_BYTES + 1))
        self.assertFalse(oversized["ok"])
        self.assertFalse((self.base / "Documents").exists())

    def test_invalid_config_returns_framed_failure_without_saving(self):
        result = self.host_process(frame(request()), config=[])
        self.assertFalse(result["ok"])
        self.assertFalse((self.base / "Documents").exists())

    @unittest.skipUnless(sys.platform == "darwin", "macOS installer")
    def test_launcher_installs_from_unrelated_working_directory(self):
        browser = self.base / "isolated-browser"
        result = subprocess.run(["/bin/zsh", str(ROOT / "Install Editor Helper.command"), "--extension-id", "a" * 32, "--browser-dir", str(browser)], input="\n", capture_output=True, text=True, timeout=10, cwd="/", env={**os.environ, "HOME": str(self.base), "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((browser / "NativeMessagingHosts" / f"{host.HOST_NAME}.json").is_file())

    @unittest.skipUnless(sys.platform == "darwin", "macOS installer")
    def test_installer_stable_registration_and_uninstall_preserve_snapshots(self):
        browser = self.base / "isolated-browser"
        env = {**os.environ, "HOME": str(self.base), "PYTHONDONTWRITEBYTECODE": "1"}
        command = [sys.executable, str(ROOT / "native" / "install.py"), "--extension-id", "a" * 32, "--browser-dir", str(browser)]
        for _ in range(2):
            result = subprocess.run(command, capture_output=True, text=True, env=env, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
        registry = browser / "NativeMessagingHosts" / f"{host.HOST_NAME}.json"
        manifest = json.loads(registry.read_text())
        self.assertEqual(manifest["allowed_origins"], [ORIGIN])
        installed = Path(manifest["path"])
        self.assertEqual(installed.stat().st_mode & 0o777, 0o700)
        response = subprocess.run([str(installed), "chrome-extension://" + "b" * 32 + "/"], input=frame(request()), capture_output=True, env=env, timeout=10)
        self.assertFalse(decode_frame(response.stdout)["ok"])
        snapshots = self.base / "Documents" / "Tab Sorter Snapshots"
        snapshots.mkdir(parents=True)
        retained = snapshots / "keep.md"
        retained.write_text("keep")
        result = subprocess.run(command + ["--uninstall"], capture_output=True, text=True, env=env, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(registry.exists())
        self.assertFalse(installed.exists())
        self.assertEqual(retained.read_text(), "keep")


if __name__ == "__main__":
    unittest.main(verbosity=2)
