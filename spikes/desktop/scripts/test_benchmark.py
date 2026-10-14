import json
import os
import plistlib
import sys
import tempfile
import unittest
from pathlib import Path
from benchmark import OwnedProcess, TrialFailure, inventory, launch_path, parse_ready


class BenchmarkTests(unittest.TestCase):
    def test_ready_requires_correct_shell_stage_and_pid_and_discards_unknown_fields(self):
        value = {'version': 1, 'shell': 'gpui', 'stage': 'window_created', 'pid': 12, 'token': 'do-not-retain'}
        line = 'DESKTOP_READY ' + json.dumps(value)
        self.assertNotIn('token', parse_ready(line, 'gpui'))
        self.assertIsNone(parse_ready(line, 'tauri'))
        self.assertIsNone(parse_ready('DESKTOP_READY not-json', 'gpui'))
        self.assertIsNone(parse_ready('noise', 'gpui'))

    def test_process_receipt_is_bounded_and_timeout_is_not_success(self):
        code = "import os,json,time; print('DESKTOP_READY '+json.dumps(dict(version=1,shell='gpui',stage='window_created',pid=os.getpid())),flush=True); time.sleep(10)"
        child = OwnedProcess([sys.executable, '-c', code], Path.cwd(), os.environ.copy(), 'gpui')
        try:
            elapsed, event = child.ready(2)
            self.assertGreater(elapsed, 0)
            self.assertEqual(event['pid'], child.process.pid)
        finally:
            child.close()
        silent = OwnedProcess([sys.executable, '-c', 'import time; time.sleep(10)'], Path.cwd(), os.environ.copy(), 'gpui')
        try:
            with self.assertRaisesRegex(TrialFailure, 'readiness_timeout'):
                silent.ready(1)
        finally:
            silent.close()
        self.assertIsNotNone(silent.process.poll())

    def test_inventory_does_not_follow_symlinks_outside_bundle(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root/'file').write_bytes(b'123')
            (root/'external').symlink_to('/usr')
            result = inventory(root)
            self.assertEqual(result['logical_bytes'], 3)
            self.assertEqual(result['symlinks_not_followed'], 1)

    def test_mac_bundle_reads_executable_from_plist_and_preserves_spaces(self):
        with tempfile.TemporaryDirectory() as folder:
            app = Path(folder) / 'Goblin Electrobun.app'
            (app / 'Contents').mkdir(parents=True)
            with (app / 'Contents/Info.plist').open('wb') as output:
                plistlib.dump({'CFBundleExecutable': 'launcher'}, output)
            executable, cwd = launch_path(app)
            self.assertEqual(executable, (app / 'Contents/MacOS/launcher').resolve())
            self.assertEqual(cwd, app.resolve())


if __name__ == '__main__':
    unittest.main()
