#!/usr/bin/env python3
"""Record completion evidence, then forward the unchanged event to the existing notifier."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def record_completion(argument, root):
    event = json.loads(argument)
    if event.get("type") != "agent-turn-complete":
        return
    session_id = event.get("thread-id")
    turn_id = event.get("turn-id")
    if not all(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value)
               for value in (session_id, turn_id)):
        raise ValueError("Completion event has no valid session and turn identifiers")
    directory = root / "completions"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Store identifiers only. Prompts and replies never enter Tab Manager's files.
    descriptor, temporary = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(descriptor, "w") as output:
            json.dump({"sessionId": session_id, "turnId": turn_id}, output)
        os.replace(temporary, directory / f"{session_id}-{turn_id}.json")
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "tab-manager"
    failed = False
    try:
        record_completion(sys.argv[1], root)
    except Exception:
        # Do not print the event, which includes private conversation text.
        print("Tab Manager: could not record Codex completion", file=sys.stderr)
        failed = True
    try:
        previous = json.loads((root / "previous-notify.json").read_text())
        if previous:
            subprocess.run(previous + sys.argv[1:], check=True)
    except Exception:
        print("Tab Manager: existing Codex notifier failed", file=sys.stderr)
        failed = True
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
