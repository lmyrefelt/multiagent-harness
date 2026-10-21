#!/usr/bin/env python3
"""Run headed qualification in an accessible existing Linux desktop session."""
import glob
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys

KEYS = ("DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS")


def candidates(env, proc_root=Path('/proc'), uid=None):
    uid = os.getuid() if uid is None else uid
    # Explicit host configuration wins; do not silently choose another desktop.
    if env.get('GODOT_DISPLAY'):
        selected = dict(env, DISPLAY=env['GODOT_DISPLAY'])
        if env.get('GODOT_XAUTHORITY'):
            selected['XAUTHORITY'] = env['GODOT_XAUTHORITY']
        yield 'configured desktop', selected
        return
    if env.get('DISPLAY'):
        yield 'inherited desktop', dict(env)
    # Read only this SSH user's processes. Never borrow another user's cookie.
    for entry in sorted(proc_root.glob('[0-9]*')):
        try:
            if entry.stat().st_uid != uid:
                continue
            name = (entry / 'comm').read_text().strip()
            if not any(x in name.lower() for x in ('gnome', 'plasma', 'xfce', 'cinnamon', 'mate', 'xwayland', 'session')):
                continue
            values = {}
            for field in (entry / 'environ').read_bytes().split(b'\0'):
                key, sep, value = field.partition(b'=')
                if sep and key.decode(errors='replace') in KEYS:
                    values[key.decode()] = value.decode(errors='surrogateescape')
            if values.get('DISPLAY'):
                yield 'runner desktop process', dict(env, **values)
        except (OSError, ValueError):
            continue
    # Ubuntu commonly keeps the Xwayland authority in its runner-owned GDM dir.
    authorities = [env.get('GODOT_XAUTHORITY'), env.get('XAUTHORITY'),
                   f'/run/user/{uid}/gdm/Xauthority', str(Path.home() / '.Xauthority')]
    for socket in sorted(glob.glob('/tmp/.X11-unix/X[0-9]*')):
        display = ':' + Path(socket).name[1:]
        for authority in dict.fromkeys(x for x in authorities if x):
            if os.access(authority, os.R_OK):
                yield 'local desktop socket', dict(env, DISPLAY=display, XAUTHORITY=authority)


def access_result(env):
    authority = env.get('XAUTHORITY')
    if authority and not os.access(authority, os.R_OK):
        return False, 'XAUTHORITY file is missing or unreadable by this runner'
    # These tools test the runner's actual display permissions, not WM brand.
    probe = (['xdpyinfo'] if shutil.which('xdpyinfo') else
             ['xprop', '-root'] if shutil.which('xprop') else None)
    if probe is None:
        # Browser startup is the access probe when X11 diagnostic tools are absent.
        return True, 'no X11 probe utility; browser startup will verify access'
    try:
        result = subprocess.run(probe, env=env, stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE, text=True, timeout=5)
        detail = ' | '.join((result.stderr or '').splitlines()[:3])[:400]
        return result.returncode == 0, f'{probe[0]} exit={result.returncode}: {detail or "no stderr"}'
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, f'{probe[0]}: {type(error).__name__}'


def accessible(env):
    return access_result(env)[0]


def failure_diagnostics(seen):
    user = pwd.getpwuid(os.getuid()).pw_name
    print(f'DESKTOP DIAG: SSH job running as {user} uid={os.getuid()}; graphical-session candidates={len(seen)}', flush=True)
    for key in ('GODOT_DISPLAY', 'DISPLAY', 'GODOT_XAUTHORITY', 'XAUTHORITY', 'XDG_RUNTIME_DIR'):
        # Paths/display addresses only. Never print cookies or the full environment.
        print(f'DESKTOP DIAG: {key}={os.environ.get(key) or "<unset>"}', flush=True)
    print(f'DESKTOP DIAG: X11 sockets={sorted(glob.glob("/tmp/.X11-unix/X[0-9]*"))}', flush=True)
    if shutil.which('loginctl'):
        try:
            result = subprocess.run(['loginctl', 'list-sessions', '--no-legend', '--no-pager'],
                                    capture_output=True, text=True, timeout=5)
            print('DESKTOP DIAG: login sessions (session/uid/user/seat/tty): ' +
                  ' | '.join(result.stdout.splitlines()[:8]), flush=True)
        except (OSError, subprocess.TimeoutExpired):
            print('DESKTOP DIAG: loginctl unavailable', flush=True)


def main(argv):
    if not argv:
        print('usage: desktop_session.py <command> [args...]', file=sys.stderr)
        return 2
    seen = set()
    for source, env in candidates(os.environ):
        key = (env.get('DISPLAY'), env.get('XAUTHORITY'))
        if key in seen:
            continue
        seen.add(key)
        ok, reason = access_result(env)
        if not ok:
            print(f'DESKTOP DIAG: rejected {source}: DISPLAY={env.get("DISPLAY")} '
                  f'XAUTHORITY={env.get("XAUTHORITY") or "<default>"}; {reason}', flush=True)
            continue
        # Use Ubuntu's existing X/Xwayland desktop, including its window manager.
        env['GDK_BACKEND'] = 'x11'
        print(f'headed qualification: existing desktop DISPLAY={env["DISPLAY"]} ({source})', flush=True)
        if argv in (['--probe'], ['--diagnose']):
            return 0
        os.execvpe(argv[0], argv, env)
    failure_diagnostics(seen)
    print('INFRA: runner cannot access the existing Ubuntu desktop session. '
          'Set GODOT_DISPLAY and GODOT_XAUTHORITY to that session in godot-host.env; '
          'the SSH runner must have display access (or use the desktop login user). '
          'No Openbox/Fluxbox installation is required.', file=sys.stderr)
    return 3


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
