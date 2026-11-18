import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

/** One regular file from a tar archive. */
export interface TarFile {
  name: string;
  data: Buffer;
}

/**
 * Minimal tar reader (ustar + pax `path` + GNU long names), enough for `helm package` output.
 * Only regular files are returned; links, devices and directories are skipped.
 */
export function readTar(buf: Buffer): TarFile[] {
  const out: TarFile[] = [];
  let off = 0;
  let longName: string | undefined;
  let paxPath: string | undefined;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseOctal(h.subarray(124, 136));
    const type = String.fromCharCode(h[156] || 48);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      longName = cstr(body);
      continue;
    }
    if (type === 'x') {
      paxPath = paxRecords(body).path;
      continue;
    }
    if (type === 'g') continue;

    let name = cstr(h.subarray(0, 100));
    if (h.subarray(257, 262).toString('latin1') === 'ustar') {
      const prefix = cstr(h.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
    }
    name = paxPath ?? longName ?? name;
    paxPath = longName = undefined;
    if (type === '0' || type === '7') out.push({ name, data: Buffer.from(body) });
  }
  return out;
}

function cstr(b: Buffer): string {
  const z = b.indexOf(0);
  return b.subarray(0, z < 0 ? b.length : z).toString('utf8');
}

function parseOctal(b: Buffer): number {
  if (b[0] & 0x80) {
    // base-256 (GNU) for large sizes
    let n = 0;
    for (let i = 1; i < b.length; i++) n = n * 256 + b[i];
    return n;
  }
  const s = cstr(b).trim();
  return s ? parseInt(s, 8) : 0;
}

function paxRecords(b: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < b.length) {
    const sp = b.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(b.subarray(i, sp).toString('latin1'), 10);
    if (!len) break;
    const rec = b.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Unpacks `charts/*.tgz` subcharts into a cache directory so they can be indexed like vendored
 * charts. The cache key includes the archive's path, mtime and size, so a re-packaged archive is
 * unpacked again; stale unpackings of the same archive are removed.
 */
export class PackagedChartCache {
  constructor(readonly root: string) {}

  /** Returns the directory containing the unpacked chart's Chart.yaml, or undefined on failure. */
  unpack(tgz: string): string | undefined {
    let st: fs.Stats;
    try {
      st = fs.statSync(tgz);
    } catch {
      return undefined;
    }
    const id = crypto.createHash('sha1').update(path.resolve(tgz)).digest('hex').slice(0, 16);
    const key = `${id}-${Math.floor(st.mtimeMs)}-${st.size}`;
    const dest = path.join(this.root, key);
    const done = path.join(dest, '.helm-navigator-complete');
    if (!fs.existsSync(done)) {
      try {
        this.removeStale(id);
        fs.rmSync(dest, { recursive: true, force: true });
        extractTgz(tgz, dest);
        fs.writeFileSync(done, path.resolve(tgz));
      } catch {
        fs.rmSync(dest, { recursive: true, force: true });
        return undefined;
      }
    }
    return chartDirIn(dest);
  }

  /** True if `file` lives inside an unpacked archive (read-only content). */
  contains(file: string): boolean {
    const rel = path.relative(this.root, path.resolve(file));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  private removeStale(id: string): void {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.root);
    } catch {
      return;
    }
    for (const n of names) if (n.startsWith(id + '-')) fs.rmSync(path.join(this.root, n), { recursive: true, force: true });
  }
}

/** Extracts a gzipped tarball into `dest`, rejecting entries that would escape it. Files are made read-only. */
export function extractTgz(tgz: string, dest: string): void {
  const files = readTar(zlib.gunzipSync(fs.readFileSync(tgz)));
  const root = path.resolve(dest);
  for (const f of files) {
    const target = path.resolve(root, f.name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`unsafe path in archive: ${f.name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data, { mode: 0o444 });
  }
}

/** The top-level directory of an unpacked chart (`<name>/Chart.yaml`). */
function chartDirIn(dest: string): string | undefined {
  try {
    for (const e of fs.readdirSync(dest, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(dest, e.name, 'Chart.yaml'))) return path.join(dest, e.name);
    }
  } catch {
    /* fall through */
  }
  return undefined;
}
