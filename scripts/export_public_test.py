"""Export tests cover privacy, history shape, idempotency and divergence guards."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
import shutil
import unittest

from export_public import export


def command(args, cwd):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()


class PublicExportTest(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="goblin-export-test-"))
        self.source = self.directory / "source"
        self.destination = self.directory / "public"
        self.source.mkdir()
        command(["init", "-b", "main"], self.source)
        command(["config", "user.name", "Author"], self.source)
        command(["config", "user.email", "author@example.test"], self.source)

    def tearDown(self):
        shutil.rmtree(self.directory)

    def commit(self, message):
        command(["add", "-A"], self.source)
        command(["commit", "-m", message], self.source)
        return command(["rev-parse", "HEAD"], self.source)

    def test_excludes_private_paths_and_redacts_operational_text(self):
        (self.source / "src").mkdir()
        (self.source / "src/app.ts").write_text("const app = true\n")
        (self.source / "AGENTS.md").write_text("private\n")
        (self.source / "evidence").mkdir()
        (self.source / "evidence/handoff.md").write_text("private\n")
        (self.source / "docs.md").write_text("/home/kristjan/code/goblin and ws_abcdefghijklmnop\n")
        sha = self.commit("initial")
        result = export(self.source, self.destination, sha, self.directory / "map.json")
        self.assertEqual(result["exported"], 1)
        self.assertTrue((self.destination / "src/app.ts").exists())
        self.assertFalse((self.destination / "AGENTS.md").exists())
        self.assertFalse((self.destination / "evidence/handoff.md").exists())
        text = (self.destination / "docs.md").read_text()
        self.assertNotIn("/home/kristjan", text)
        self.assertNotIn("ws_abcdefghijklmnop", text)
        self.assertIn("private-workspace", text)

    def test_incremental_export_is_idempotent_and_preserves_authorship(self):
        (self.source / "app.ts").write_text("one\n")
        first = self.commit("first")
        map_path = self.directory / "map.json"
        initial = export(self.source, self.destination, first, map_path)
        before = command(["rev-parse", "HEAD"], self.destination)
        again = export(self.source, self.destination, first, map_path)
        self.assertEqual(again["public"], before)
        self.assertEqual(again["exported"], 0)
        (self.source / "app.ts").write_text("two\n")
        second = self.commit("second")
        updated = export(self.source, self.destination, second, map_path)
        self.assertEqual(updated["exported"], 1)
        self.assertEqual(command(["show", "-s", "--format=%an", "HEAD"], self.destination), "Author")
        self.assertEqual(initial["public"], before)

    def test_diverged_public_history_is_rejected(self):
        (self.source / "app.ts").write_text("one\n")
        sha = self.commit("first")
        map_path = self.directory / "map.json"
        export(self.source, self.destination, sha, map_path)
        (self.destination / "manual.md").write_text("unreviewed\n")
        command(["add", "-A"], self.destination)
        command(["commit", "-m", "manual"], self.destination)
        with self.assertRaises(RuntimeError):
            export(self.source, self.destination, sha, map_path)

    def test_excluded_only_changes_skip_and_deletions_survive(self):
        (self.source / 'app.ts').write_text('public source')
        first = self.commit('first')
        map_path = self.directory / 'map.json'
        initial = export(self.source, self.destination, first, map_path)
        (self.source / 'AGENTS.md').write_text('private detail')
        second = self.commit('private only /home/kristjan/code/goblin')
        skipped = export(self.source, self.destination, second, map_path)
        self.assertEqual(skipped['exported'], 0)
        self.assertEqual(skipped['public'], initial['public'])
        (self.source / 'app.ts').unlink()
        final = self.commit('remove source /home/kristjan/code/goblin')
        export(self.source, self.destination, final, map_path)
        self.assertFalse((self.destination / 'app.ts').exists())
        history = command(['log', '--format=%B'], self.destination)
        self.assertNotIn('/home/kristjan', history)
        self.assertNotIn('AGENTS.md', command(['rev-list', '--objects', 'HEAD'], self.destination))

    def test_author_dates_and_emails_are_preserved(self):
        (self.source / 'app.ts').write_text('source')
        sha = self.commit('source change')
        result = export(self.source, self.destination, sha, self.directory / 'map.json')
        format = '--format=%an|%ae|%aI|%cn|%ce|%cI'
        self.assertEqual(command(['show', '-s', format, sha], self.source),
                         command(['show', '-s', format, result['public']], self.destination))

    def test_wallet_licenses_and_disclosure_assets_survive(self):
        for path in ['apps/wallet', 'apps/wallet-web', 'packages/wallet']:
            workspace = self.source / path
            workspace.mkdir(parents=True)
            (workspace / 'LICENSE').write_text('MIT License\n')
            (workspace / 'package.json').write_text(json.dumps({'name': path, 'license': 'MIT'}))
        images = self.source / 'docs/images/wallet'
        images.mkdir(parents=True)
        (images / 'proof.png').write_bytes(b'\x89PNG\r\n')
        sha = self.commit('Wallet MIT licenses and public proof')
        export(self.source, self.destination, sha, self.directory / 'map.json')
        for path in ['apps/wallet', 'apps/wallet-web', 'packages/wallet']:
            self.assertEqual((self.destination / path / 'LICENSE').read_text(), 'MIT License\n')
            self.assertEqual(json.loads((self.destination / path / 'package.json').read_text())['license'], 'MIT')
        self.assertEqual((self.destination / 'docs/images/wallet/proof.png').read_bytes(), b'\x89PNG\r\n')

    def test_private_history_cannot_rewind_or_without_map(self):
        (self.source / 'app.ts').write_text('one')
        first = self.commit('first')
        (self.source / 'app.ts').write_text('two')
        second = self.commit('second')
        map_path = self.directory / 'map.json'
        export(self.source, self.destination, second, map_path)
        with self.assertRaises(RuntimeError):
            export(self.source, self.destination, first, map_path)
        map_path.unlink()
        with self.assertRaises(RuntimeError):
            export(self.source, self.destination, second, map_path)


if __name__ == "__main__":
    unittest.main()
