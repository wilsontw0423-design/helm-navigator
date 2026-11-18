import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { PackagedChartCache, extractTgz, readTar } from '../src/core/archive';
import { HelmIndex } from '../src/core/helmIndex';
import { NodeHost } from '../src/core/host';

const FX = path.join(__dirname, 'fixtures');
const parentDir = path.join(FX, 'packaged');
const tgz = path.join(parentDir, 'charts/packed-0.1.0.tgz');
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'helm-nav-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makeIndex(cacheRoot = path.join(tmp, 'cache')) {
  const idx = new HelmIndex(new NodeHost(), ['values.yaml'], new PackagedChartCache(cacheRoot));
  idx.graph.addChartFiles([path.join(parentDir, 'Chart.yaml')]);
  return idx;
}

/** Builds a tar header block for a regular file. */
function tarEntry(name: string, body: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(Buffer.byteLength(body).toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
  data.write(body);
  return Buffer.concat([h, data]);
}

describe('packaged subcharts (charts/*.tgz)', () => {
  it('reads helm package output', () => {
    const names = readTar(zlib.gunzipSync(fs.readFileSync(tgz))).map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['packed/Chart.yaml', 'packed/values.yaml', 'packed/templates/svc.yaml']));
  });

  it('links the unpacked chart as a subchart of the parent', () => {
    const idx = makeIndex();
    const u = idx.graph.get(parentDir)!;
    const link = u.subcharts.find((s) => s.alias === 'packed')!;
    expect(link.chart?.name).toBe('packed');
    expect(link.chart?.packagedFrom).toBe(tgz);
    expect(link.packagedPath).toBe(tgz);
    expect(link.chart!.parents.map((p) => p.parent.name)).toEqual(['packaged']);
  });

  it('parent values key packed.port → packaged chart default', () => {
    const idx = makeIndex();
    const locs = idx.relatedValueLocations(idx.graph.get(parentDir)!, ['packed', 'port']);
    expect(locs).toHaveLength(1);
    expect(path.basename(locs[0].file)).toBe('values.yaml');
    expect(fs.readFileSync(locs[0].file, 'utf8').slice(locs[0].start, locs[0].end)).toBe('port');
    expect(idx.graph.packages!.contains(locs[0].file)).toBe(true);
  });

  it('override chain and defines reach into the archive', () => {
    const idx = makeIndex();
    const packed = idx.graph.get(parentDir)!.subcharts.find((s) => s.alias === 'packed')!.chart!;
    const chain = idx.overrideChain(packed, ['port']).filter((c) => c.entries.length);
    expect(chain.map((c) => [c.role, c.chart.name, c.entries[0].preview])).toEqual([
      ['default', 'packed', '8080'],
      ['override', 'packaged', '9090'],
    ]);
    expect(idx.findDefines(idx.graph.get(parentDir)!, 'packed.name')).toHaveLength(1);
  });

  it('reuses the cache and re-unpacks when the archive changes', () => {
    const root = path.join(tmp, 'cache2');
    const copy = path.join(tmp, 'packed-0.1.0.tgz');
    fs.copyFileSync(tgz, copy);
    const cache = new PackagedChartCache(root);
    const a = cache.unpack(copy)!;
    expect(cache.unpack(copy)).toBe(a);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(copy, later, later);
    const b = cache.unpack(copy)!;
    expect(b).not.toBe(a);
    expect(fs.existsSync(a)).toBe(false); // stale unpacking removed
    expect(fs.statSync(path.join(b, 'values.yaml')).mode & 0o222).toBe(0); // read-only
  });

  it('without a cache, only records the archive path', () => {
    const idx = new HelmIndex(new NodeHost());
    idx.graph.addChartFiles([path.join(parentDir, 'Chart.yaml')]);
    const link = idx.graph.get(parentDir)!.subcharts.find((s) => s.alias === 'packed')!;
    expect(link.chart).toBeUndefined();
    expect(link.packagedPath).toBe(tgz);
  });

  it('rejects entries that escape the destination', () => {
    const evil = path.join(tmp, 'evil.tgz');
    fs.writeFileSync(evil, zlib.gzipSync(Buffer.concat([tarEntry('../evil.txt', 'x'), Buffer.alloc(1024)])));
    expect(() => extractTgz(evil, path.join(tmp, 'evil-out'))).toThrow(/unsafe path/);
    expect(fs.existsSync(path.join(tmp, 'evil.txt'))).toBe(false);
    expect(new PackagedChartCache(path.join(tmp, 'cache3')).unpack(evil)).toBeUndefined();
  });
});
