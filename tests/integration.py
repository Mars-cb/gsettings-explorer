#!/usr/bin/env python3
"""Exercise a real GSettings change inside a disposable D-Bus session."""

import json
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]


def run():
    with tempfile.TemporaryDirectory(prefix='gsettings-explorer-test-') as directory:
        environment = dict(os.environ)
        config_dir = pathlib.Path(directory) / 'config'
        runtime_dir = pathlib.Path(directory) / 'runtime'
        config_dir.mkdir()
        runtime_dir.mkdir(mode=0o700)
        environment['XDG_CONFIG_HOME'] = str(config_dir)
        environment['XDG_RUNTIME_DIR'] = str(runtime_dir)
        subprocess.run(
            ['dbus-run-session', '--', sys.executable, str(__file__), '--child'],
            env=environment, timeout=12, check=True)


def child_run():
        environment = dict(os.environ)
        helper = subprocess.Popen(
            [sys.executable, str(ROOT / 'helper.py'), 'watch',
             'org.gnome.desktop.interface', 'clock-show-seconds', ''],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=environment)
        try:
            ready = json.loads(helper.stdout.readline())
            assert ready['type'] == 'ready', ready
            new_value = 'false' if ready['value'] == 'true' else 'true'
            subprocess.run(
                ['gsettings', 'set', 'org.gnome.desktop.interface',
                 'clock-show-seconds', new_value],
                env=environment, check=True, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL)
            changed = json.loads(helper.stdout.readline())
            assert changed['type'] == 'change', changed
            assert changed['oldValue'] == ready['value'], changed
            assert changed['newValue'] == new_value, changed
            assert changed['observedAt'] and changed['previousObservedAt'], changed
            print('watch integration: passed')
        finally:
            helper.terminate()
            helper.wait(timeout=5)


if __name__ == '__main__':
    child_run() if '--child' in sys.argv else run()
