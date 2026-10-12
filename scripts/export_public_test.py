"""Export tests cover privacy, history shape, idempotency and divergence guards."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
import shutil
import unittest

from export_public import export, transform


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

    def test_excludes_nested_evidence_directories(self):
        nested = self.source / 'docs/archive/initial/evidence'
        nested.mkdir(parents=True)
        (nested / 'deployment.json').write_text('{"token":"fixture-secret"}\n')
        sha = self.commit('nested evidence')
        export(self.source, self.destination, sha, self.directory / 'map.json')
        self.assertFalse((self.destination / 'docs/archive/initial/evidence/deployment.json').exists())

    def test_sanitizing_private_urls_keeps_source_delimiters(self):
        (self.source / 'source.ts').write_text(
            "const a = 'https://myplan.example/mcp/ws_abcdefghijklmnop';\n"
            'const b = "file:///home/kristjan/private-note";\n'
        )
        sha = self.commit('sanitize private URLs')
        export(self.source, self.destination, sha, self.directory / 'map.json')
        source = (self.destination / 'source.ts').read_text()
        self.assertIn("'https://example.invalid/private-reference';", source)
        self.assertIn('"https://example.invalid/private-reference";', source)

    def test_synthetic_resource_uris_and_workspace_placeholders_stay_usable(self):
        for fixture in [
            b"const uri = 'file:///out/report 1.csv'",
            b"const stack = 'at read (file:///worker.js:10:5)'",
            b"const uri = 'https://myplan.lol/mcp/ws_ab12'",
            b"const uri = 'https://dev.myplan.lol/workspaces/ws_fixture/items/item_fixture'",
        ]:
            self.assertEqual(transform('fixture.ts', fixture), fixture)

    def test_public_knip_retains_hint_gate_without_excluded_skill_glob(self):
        config = b'''{
  "treatConfigHintsAsErrors": true,
  // Vendored agent skills (scripts, assets) are upstream files, not goblin sources.
  "ignore": ["tools/oxlint/anti-slop/**", ".agents/skills/**"]
}
'''
        public = transform('knip.jsonc', config).decode()
        self.assertNotIn('.agents/skills', public)
        self.assertIn('"treatConfigHintsAsErrors": true', public)
        self.assertIn('"ignore": ["tools/oxlint/anti-slop/**"]', public)

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

    def test_public_readme_tracks_source_wallet_proof_and_disclosure(self):
        (self.source / 'README.md').write_text(
            '# goblin\n\n**Goblin Wallet** at wallet.goblin.surf.\n'
            '![Proof](docs/images/wallet/proof.png)\n\n'
            'Built on the native SDK.\n\n'
            '## Hackathon disclosure\n\nBuilt inside the contest window; reused Sidequest patterns.\n'
        )
        sha = self.commit('Updated Wallet proof and provenance')
        export(self.source, self.destination, sha, self.directory / 'map.json')
        readme = (self.destination / 'README.md').read_text()
        self.assertIn('**Goblin Wallet** at wallet.goblin.surf.', readme)
        self.assertIn('![Proof](docs/images/wallet/proof.png)', readme)
        self.assertIn('Built inside the contest window; reused Sidequest patterns.', readme)
        self.assertIn('bun run check:public', readme)

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
