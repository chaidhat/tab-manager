import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest


class NotificationTests(unittest.TestCase):
    def test_install_forward_record_and_reinstall(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            forwarded = home / "forwarded.json"
            old = home / "old.py"
            old.write_text("import sys\nfrom pathlib import Path\nPath(sys.argv[1]).write_text(sys.argv[2])\n")
            previous = [sys.executable, str(old), str(forwarded)]
            original = 'notify = ' + json.dumps(previous) + '\n[features]\nexample = true\n'
            (home / 'config.toml').write_text(original)
            environment = dict(os.environ, CODEX_HOME=str(home))
            installer = Path(__file__).with_name('install-codex-notify.py')
            for _ in range(2):
                subprocess.run([sys.executable, str(installer)], env=environment, check=True, capture_output=True)
            config = tomllib.loads((home / 'config.toml').read_text())
            self.assertEqual(config['features'], {'example': True})
            root = home / 'tab-manager'
            self.assertEqual(json.loads((root / 'previous-notify.json').read_text()), previous)
            self.assertEqual((root / 'config.before-notify.toml').read_text(), original)
            event = json.dumps({'type': 'agent-turn-complete', 'thread-id': 'session-1',
                                'turn-id': 'turn-2', 'last-assistant-message': 'private text'})
            for _ in range(2):
                subprocess.run(config['notify'] + [event], env=environment, check=True)
            self.assertEqual(forwarded.read_text(), event)
            records = list((root / 'completions').glob('*.json'))
            self.assertEqual(len(records), 1)
            self.assertEqual(json.loads(records[0].read_text()), {'sessionId': 'session-1', 'turnId': 'turn-2'})
            bad = json.dumps({'type': 'agent-turn-complete', 'thread-id': '../escape', 'turn-id': 'x'})
            result = subprocess.run(config['notify'] + [bad], env=environment, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(forwarded.read_text(), bad)
            self.assertEqual(len(list((root / 'completions').glob('*.json'))), 1)


if __name__ == '__main__':
    unittest.main()
