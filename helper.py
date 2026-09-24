#!/usr/bin/env python3
"""Run on the selected machine; emit one JSON object per line."""

import datetime
import json
import os
import pwd
import re
import signal
import subprocess
import sys
import threading
import time

if not os.environ.get('DBUS_SESSION_BUS_ADDRESS'):
    bus_path = '/run/user/{}/bus'.format(os.getuid())
    if os.path.exists(bus_path):
        os.environ['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=' + bus_path

import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def schema_source():
    source = Gio.SettingsSchemaSource.get_default()
    if source is None:
        raise RuntimeError('未找到 GSettings schema source')
    return source


def get_schema(schema_id):
    schema = schema_source().lookup(schema_id, True)
    if schema is None:
        raise ValueError('找不到 schema: ' + schema_id)
    return schema


def settings_for(schema_id, path):
    schema = get_schema(schema_id)
    schema_path = schema.get_path()
    if schema_path is None:
        if not path or not re.fullmatch(r'/(?:[A-Za-z0-9_.-]+/)+', path):
            raise ValueError('可重定位 schema 需要以 / 开头和结尾的有效路径')
        return Gio.Settings.new_with_path(schema_id, path), schema
    if path and path != schema_path:
        raise ValueError('固定路径 schema 的路径必须是 ' + schema_path)
    return Gio.Settings.new(schema_id), schema


def snapshot():
    source = schema_source()
    fixed, relocatable = source.list_schemas(True)
    items = []
    for schema_id in sorted(fixed + relocatable):
        try:
            schema = get_schema(schema_id)
            path = schema.get_path()
            settings = Gio.Settings.new(schema_id) if path else None
            for key in sorted(schema.list_keys()):
                key_schema = schema.get_key(key)
                value = settings.get_value(key).print_(True) if settings else None
                default = key_schema.get_default_value().print_(True)
                items.append({
                    'schema': schema_id, 'key': key, 'path': path,
                    'value': value, 'default': default,
                    'type': key_schema.get_value_type().dup_string(),
                    'summary': key_schema.get_summary() or '',
                    'description': key_schema.get_description() or '',
                    'writable': settings.is_writable(key) if settings else None,
                    'userValue': settings.get_user_value(key) is not None if settings else None,
                })
        except Exception as exc:
            items.append({'schema': schema_id, 'key': '', 'error': str(exc)})
    emit({'type': 'snapshot', 'items': items, 'capturedAt': now()})


def inspect_key(schema_id, key, path):
    settings, schema = settings_for(schema_id, path)
    if key not in schema.list_keys():
        raise ValueError('找不到 key: ' + key)
    emit({'type': 'key', 'schema': schema_id, 'key': key,
          'path': schema.get_path() or path,
          'value': settings.get_value(key).print_(True),
          'writable': settings.is_writable(key),
          'userValue': settings.get_user_value(key) is not None,
          'capturedAt': now()})


class WriterObserver:
    """Optional, approximate dconf D-Bus writer attribution."""

    def __init__(self):
        self.events = []
        self.lock = threading.Lock()
        self.process = None
        self.status = '不可用'

    def start(self):
        try:
            self.process = subprocess.Popen(
                ['dbus-monitor', '--session',
                 "type='method_call',interface='ca.desrt.dconf.Writer'"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                universal_newlines=True, bufsize=1)
            self.status = '运行中（仅供参考）'
            threading.Thread(target=self.read, daemon=True).start()
        except (OSError, ValueError):
            self.status = '不可用'

    def read(self):
        header = re.compile(r'^method call .*sender=(:[\w.]+).*interface=ca\.desrt\.dconf\.Writer; member=(?:Change|ChangeFast)\b')
        for line in self.process.stdout:
            match = header.search(line)
            if not match:
                continue
            sender = match.group(1)
            identity = self.lookup(sender)
            with self.lock:
                self.events.append((time.monotonic(), identity))
                self.events = self.events[-30:]

    def lookup(self, sender):
        try:
            bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            result = bus.call_sync(
                'org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
                GLib.Variant('(s)', (sender,)), GLib.VariantType('(u)'),
                Gio.DBusCallFlags.NONE, 500, None)
            pid = result.unpack()[0]
            with open('/proc/{}/comm'.format(pid), encoding='utf-8') as file:
                command = file.read().strip()
            with open('/proc/{}/status'.format(pid), encoding='utf-8') as file:
                uid_line = next(line for line in file if line.startswith('Uid:'))
            uid = int(uid_line.split()[1])
            return '{} ({}，PID {})'.format(pwd.getpwuid(uid).pw_name, command, pid)
        except (OSError, KeyError, StopIteration, GLib.Error):
            return '未知进程 (' + sender + ')'

    def candidate(self):
        with self.lock:
            recent = [identity for stamp, identity in self.events
                      if time.monotonic() - stamp < 1.5]
        return recent[-1] if recent else None

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()


def watch(schema_id, key, path):
    settings, schema = settings_for(schema_id, path)
    if key not in schema.list_keys():
        raise ValueError('找不到 key: ' + key)
    writer = WriterObserver()
    writer.start()
    observed_at = now()
    previous = settings.get_value(key).print_(True)
    emit({'type': 'ready', 'schema': schema_id, 'key': key,
          'path': schema.get_path() or path, 'value': previous,
          'observedAt': observed_at, 'attribution': writer.status})

    def changed(current_settings, changed_key):
        GLib.timeout_add(80, record_change, current_settings, changed_key)

    def record_change(current_settings, changed_key):
        nonlocal observed_at, previous
        current = current_settings.get_value(changed_key).print_(True)
        if current == previous:
            return False
        changed_at = now()
        candidate = writer.candidate()
        emit({'type': 'change', 'schema': schema_id, 'key': changed_key,
              'path': schema.get_path() or path,
              'oldValue': previous, 'newValue': current,
              'previousObservedAt': observed_at, 'observedAt': changed_at,
              'modifier': candidate or '无法确定',
              'modifierConfidence': '可能关联的 D-Bus 写入进程' if candidate else '无写入者信息'})
        previous, observed_at = current, changed_at
        return False

    settings.connect('changed::' + key, changed)
    loop = GLib.MainLoop()
    signal.signal(signal.SIGTERM, lambda _signum, _frame: loop.quit())
    signal.signal(signal.SIGINT, lambda _signum, _frame: loop.quit())
    try:
        loop.run()
    finally:
        writer.stop()


if __name__ == '__main__':
    try:
        if len(sys.argv) == 2 and sys.argv[1] == 'snapshot':
            snapshot()
        elif len(sys.argv) == 5 and sys.argv[1] == 'key':
            inspect_key(sys.argv[2], sys.argv[3], sys.argv[4])
        elif len(sys.argv) == 5 and sys.argv[1] == 'watch':
            watch(sys.argv[2], sys.argv[3], sys.argv[4])
        else:
            raise ValueError('用法: helper.py snapshot | watch SCHEMA KEY PATH')
    except Exception as exc:
        emit({'type': 'error', 'message': str(exc)})
        sys.exit(1)
