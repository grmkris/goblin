"""measure.py <stdout-file> <meta-file> -- cmd...: run cmd from cwd, stdout to a file, record exit, wall and peak RSS."""
import json, resource, subprocess, sys, time
out, meta = sys.argv[1], sys.argv[2]
cmd = sys.argv[sys.argv.index('--') + 1:]
start = time.monotonic()
with open(out, 'wb') as f:
    proc = subprocess.run(cmd, stdout=f, stderr=subprocess.PIPE)
wall = time.monotonic() - start
ru = resource.getrusage(resource.RUSAGE_CHILDREN)
with open(meta, 'w') as f:
    json.dump({'cmd': cmd, 'exit': proc.returncode, 'wall_s': round(wall, 2), 'peak_rss_mb': round(ru.ru_maxrss / 1024),
               'user_s': round(ru.ru_utime, 2), 'sys_s': round(ru.ru_stime, 2), 'stderr': proc.stderr.decode()[-2000:]}, f)
