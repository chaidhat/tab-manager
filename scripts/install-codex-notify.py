#!/usr/bin/env python3
"""Install the completion adapter without discarding an existing notify command."""
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import tomllib


def atomic_write(target, text):
    descriptor, temporary = tempfile.mkstemp(dir=target.parent)
    try:
        with os.fdopen(descriptor, "w") as output:
            output.write(text)
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    config = home / "config.toml"
    original = config.read_text()
    parsed = tomllib.loads(original)
    previous = parsed.get("notify", [])
    if not isinstance(previous, list) or not all(isinstance(item, str) for item in previous):
        raise ValueError("Existing notify command must be a list of strings")
    root = home / "tab-manager"
    root.mkdir(mode=0o700, exist_ok=True)
    (root / "completions").mkdir(mode=0o700, exist_ok=True)
    adapter = root / "codex-notify.py"
    command = [sys.executable, str(adapter)]
    if str(adapter) not in previous:
        # Refuse unfamiliar formatting rather than risk rewriting unrelated settings.
        pattern = re.compile(r"^notify\s*=.*$", re.MULTILINE)
        replacement = "notify = " + json.dumps(command)
        if previous:
            matches = list(pattern.finditer(original))
            if len(matches) != 1 or tomllib.loads(matches[0].group()).get("notify") != previous:
                raise ValueError("Existing notify setting needs manual integration")
            updated = pattern.sub(lambda _: replacement, original, count=1)
        else:
            if "notify" in parsed:
                updated = pattern.sub(lambda _: replacement, original, count=1)
            else:
                updated = replacement + "\n" + original
        expected = dict(parsed, notify=command)
        if tomllib.loads(updated) != expected:
            raise ValueError("Configuration verification failed")
        backup = root / "config.before-notify.toml"
        if not backup.exists():
            atomic_write(backup, original)
        atomic_write(root / "previous-notify.json", json.dumps(previous))
    else:
        if not (root / "previous-notify.json").exists():
            raise ValueError("Previous notifier record is missing")
        updated = original
    source = Path(__file__).with_name("codex-notify.py")
    atomic_write(adapter, source.read_text())
    # Do not overwrite a configuration edited while installation was in progress.
    if config.read_text() != original:
        raise RuntimeError("Codex settings changed during installation, please retry")
    if updated != original:
        atomic_write(config, updated)
    print("Installed Tab Manager completion hook and preserved the existing notifier.")


if __name__ == "__main__":
    main()
