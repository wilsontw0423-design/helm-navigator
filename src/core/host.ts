import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * File-system abstraction so the core logic has no `vscode` dependency.
 * The extension overlays unsaved editor buffers on top of the disk.
 */
export interface Host {
  readFile(file: string): string | undefined;
  /** Opaque token that changes whenever the file content may have changed. */
  version(file: string): string;
  listDir(dir: string): { name: string; isDir: boolean }[];
  exists(file: string): boolean;
}

export class NodeHost implements Host {
  readFile(file: string): string | undefined {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  }
  version(file: string): string {
    try {
      const s = fs.statSync(file);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return 'missing';
    }
  }
  listDir(dir: string): { name: string; isDir: boolean }[] {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    } catch {
      return [];
    }
  }
  exists(file: string): boolean {
    return fs.existsSync(file);
  }
}

export function norm(p: string): string {
  return path.resolve(p);
}

/** Converts a 0-based offset into a 0-based line/character pair. */
export class LineIndex {
  private starts: number[] = [0];
  constructor(text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  position(offset: number): { line: number; character: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - this.starts[lo] };
  }
}
