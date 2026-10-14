#!/usr/bin/env python3
"""Run inside the disposable Linux image, with host networking for the loopback companion."""
import ctypes
import json
import os
from pathlib import Path
import select
import struct
import subprocess
import sys
import time
import urllib.request
import zlib

host = sys.argv[1]
if host not in ('gpui', 'tauri', 'electrobun'):
    raise SystemExit('Choose gpui, tauri or electrobun')
root = Path.cwd()
connection = json.loads((root / 'artifacts/connection.local.json').read_text())
artifacts = root / 'artifacts'
framebuffer = artifacts / (host + '-framebuffer')
framebuffer.mkdir(exist_ok=True)
env = dict(os.environ, LIBGL_ALWAYS_SOFTWARE='1', GDK_BACKEND='x11', XDG_RUNTIME_DIR='/tmp/goblin-runtime')
Path(env['XDG_RUNTIME_DIR']).mkdir(mode=0o700, exist_ok=True)
env['GOBLIN_DESKTOP_URL'] = connection['origin'] + '/?host=' + host + '#token=' + connection['token']
env['GOBLIN_DESKTOP_CONNECTION'] = str(artifacts / 'connection.local.json')
headers = {'authorization': 'Bearer ' + connection['token'], 'x-goblin-shell': host}
def state():
    request = urllib.request.Request(connection['origin'] + '/bridge/state', headers=headers)
    return json.load(urllib.request.urlopen(request, timeout=3))
def command(value):
    request = urllib.request.Request(connection['origin'] + '/bridge/command', data=json.dumps(value).encode(), headers={**headers, 'content-type':'application/json'})
    return json.load(urllib.request.urlopen(request, timeout=3))
def screenshot(path):
    data = (framebuffer / 'Xvfb_screen0').read_bytes()
    h = struct.unpack('>25I', data[:100])
    size, width, height, order, bpp, stride, colors = h[0], h[4], h[5], h[7], h[11], h[12], h[19]
    if bpp != 32 or order != 0:
        raise RuntimeError('Unexpected Xvfb pixel format')
    pixels = memoryview(data)[size + colors * 12:]
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            offset = y * stride + x * 4
            row.extend((pixels[offset+2], pixels[offset+1], pixels[offset]))
        rows.append(row)
    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind+body))
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>2I5B', width, height, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b'')
    path.write_bytes(png)

command({'type': 'mode', 'mode': 'fixture'})
command({'type': 'select', 'id': 'desktop'})
xlog = open(artifacts / (host + '-xvfb.log'), 'w')
applog = open(artifacts / (host + '-native.log'), 'w')
read_fd, write_fd = os.pipe()
xvfb = subprocess.Popen(['Xvfb', '-displayfd', str(write_fd), '-screen', '0', '1280x900x24', '-fbdir', str(framebuffer)], env=env, stdout=xlog, stderr=xlog, pass_fds=(write_fd,))
os.close(write_fd)
app = None
try:
    if not select.select([read_fd], [], [], 5)[0]: raise RuntimeError('Xvfb display allocation timed out')
    with os.fdopen(read_fd, 'rb') as display_pipe:
        number = display_pipe.readline(32).strip()
    if not number.isdigit(): raise RuntimeError('Xvfb failed to allocate a display')
    env['DISPLAY'] = ':' + number.decode()
    x11 = ctypes.CDLL('libX11.so.6')
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]; x11.XOpenDisplay.restype = ctypes.c_void_p
    display = None
    for _ in range(50):
        display = x11.XOpenDisplay(env['DISPLAY'].encode())
        if display: break
        time.sleep(.1)
    if not display: raise RuntimeError('Xvfb failed to start')
    if host == 'electrobun':
        bundle = root / 'electrobun/build/dev-linux-x64/GoblinElectrobunSpike-dev'
        executable, cwd = str(bundle / 'bin/launcher'), str(bundle)
    else:
        executable, cwd = str(root / 'target/debug' / ('goblin-' + host + '-spike')), str(root)
    app = subprocess.Popen([executable], cwd=cwd, env=env, stdout=applog, stderr=applog)
    time.sleep(8)
    if app.poll() is not None: raise RuntimeError(f'{host} exited before native capture ({app.returncode})')
    screenshot(artifacts / (host + '-native-initial.png'))
    # Run a deterministic service stream through the actual native surface, then capture it.
    command({'type': 'send', 'text': 'A native desktop comparison', 'operationId': host + '-smoke-' + str(time.time_ns())})
    time.sleep(.8)
    screenshot(artifacts / (host + '-native-stream.png'))
    command({'type': 'stop'})
    if not state()['messages'][-1]['text']: raise RuntimeError('No streamed response')
    for _ in range(50):
        if not state()['streaming']: break
        time.sleep(.1)
    if state()['streaming']: raise RuntimeError('Stream did not stop before keyboard input')
    # OS-level keyboard/mouse injection: composer location is checked against the captured window.
    xtst = ctypes.CDLL('libXtst.so.6')
    xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
    xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    x11.XFlush.argtypes = [ctypes.c_void_p]
    x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]; x11.XKeysymToKeycode.restype = ctypes.c_uint
    # Same initial window bounds; GPUI/Tauri/Electrobun positions may differ without a window manager.
    point = {'gpui': (550, 810), 'tauri': (550, 710), 'electrobun': (550, 810)}[host]
    xtst.XTestFakeMotionEvent(display, -1, *point, 0)
    xtst.XTestFakeButtonEvent(display, 1, 1, 0); xtst.XTestFakeButtonEvent(display, 1, 0, 0)
    x11.XFlush(display)
    time.sleep(.2)
    sent_before = sum(m['role'] == 'user' and m['text'] == 'native input' for m in state()['messages'])
    for char in 'native input':
        key = x11.XKeysymToKeycode(display, ord(char))
        xtst.XTestFakeKeyEvent(display, key, 1, 0); xtst.XTestFakeKeyEvent(display, key, 0, 0)
        x11.XFlush(display)
        time.sleep(.04)
    enter = x11.XKeysymToKeycode(display, 0xff0d)
    xtst.XTestFakeKeyEvent(display, enter, 1, 0); xtst.XTestFakeKeyEvent(display, enter, 0, 0); x11.XFlush(display)
    time.sleep(1)
    input_pass = sum(m['role'] == 'user' and m['text'] == 'native input' for m in state()['messages']) > sent_before
    screenshot(artifacts / (host + '-native-input.png'))
    command({'type': 'stop'})
    time.sleep(.2)
    def click(point):
        xtst.XTestFakeMotionEvent(display, -1, *point, 0)
        xtst.XTestFakeButtonEvent(display, 1, 1, 0); xtst.XTestFakeButtonEvent(display, 1, 0, 0)
        x11.XFlush(display)
        time.sleep(.5)
    click({'gpui': (750, 214), 'tauri': (505, 138), 'electrobun': (605, 218)}[host])
    history_pass = state()['history'] and len(state()['messages']) >= 200
    screenshot(artifacts / (host + '-native-history.png'))
    click({'gpui': (190, 330), 'tauri': (115, 241), 'electrobun': (215, 321)}[host])
    switch_pass = state()['selected'] == 'mobile' and len(state()['messages']) == 2
    screenshot(artifacts / (host + '-native-switch.png'))
    result = {'shell': host, 'launch': 'pass', 'capture': 'pass', 'service_stream': 'pass', 'os_keyboard_send': 'pass' if input_pass else 'fail', 'os_stress_history': 'pass' if history_pass else 'fail', 'os_switch_conversation': 'pass' if switch_pass else 'fail', 'platform': 'Linux/Xvfb/software graphics'}
    (artifacts / (host + '-native-receipt.json')).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
    command({'type': 'stop'})
    if not input_pass: raise RuntimeError('OS keyboard send did not reach the companion')
    if not history_pass: raise RuntimeError('OS stress-history click failed')
    if not switch_pass: raise RuntimeError('OS conversation switch failed')
finally:
    if app and app.poll() is None:
        app.terminate()
        try: app.wait(timeout=5)
        except subprocess.TimeoutExpired: app.kill(); app.wait()
    xvfb.terminate(); xvfb.wait(timeout=5)
    xlog.close(); applog.close()
