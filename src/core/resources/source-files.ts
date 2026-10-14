import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { computeContentHash } from "../ingestion/hasher.ts";
import { RESOURCE_LIMITS } from './limits.ts';

export interface SkippedSourceFile { path: string; reason: 'file_too_large' }
export class SourceFileLimitError extends Error {
  constructor(public readonly filePath: string) { super(`Source file exceeds ${RESOURCE_LIMITS.sourceBytes} bytes: ${filePath}`); }
}
export interface SourceReadFingerprint { path: string; hash: string; size: number; mtime: number }
const reads = new AsyncLocalStorage<{skipped: Map<string, SkippedSourceFile>; inputs: Map<string, SourceReadFingerprint>}>();

// Read at most the admission limit, even if the file grows after stat.
export function readSourceFile(filePath: string, _encoding?: string): string {
  const fd = openSync(filePath, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size > RESOURCE_LIMITS.sourceBytes) throw new SourceFileLimitError(filePath);
    let buffer = Buffer.allocUnsafe(Math.min(Math.max(size + 1, 4096), RESOURCE_LIMITS.sourceBytes + 1));
    let count = 0;
    while (true) {
      const read = readSync(fd, buffer, count, buffer.length - count, null);
      if (!read) return buffer.toString('utf8', 0, count);
      count += read;
      if (count > RESOURCE_LIMITS.sourceBytes) throw new SourceFileLimitError(filePath);
      if (count === buffer.length) {
        const expanded = Buffer.allocUnsafe(Math.min(buffer.length * 2, RESOURCE_LIMITS.sourceBytes + 1));
        buffer.copy(expanded, 0, 0, count);
        buffer = expanded;
      }
    }
  } finally { closeSync(fd); }
}

export function readOptionalSourceFile(filePath: string, encoding?: string): string {
  try {
    const content = readSourceFile(filePath, encoding);
    const collector = reads.getStore();
    if (collector) {
      const stat = statSync(filePath);
      collector.inputs.set(filePath, {path:filePath,hash:computeContentHash(content),size:stat.size,mtime:stat.mtimeMs});
    }
    return content;
  }
  catch (error) {
    if (!(error instanceof SourceFileLimitError)) throw error;
    const collector = reads.getStore();
    if (!collector) throw error;
    collector.skipped.set(filePath, { path: filePath, reason: 'file_too_large' });
    const stat = statSync(filePath);
    collector.inputs.set(filePath, {path:filePath,hash:'file_too_large',size:stat.size,mtime:stat.mtimeMs});
    return '';
  }
}

export async function collectSourceSkips<T>(root: string, read: () => Promise<T>): Promise<{ value: T; skipped: SkippedSourceFile[]; inputs: SourceReadFingerprint[] }> {
  const collector = {skipped: new Map<string, SkippedSourceFile>(), inputs: new Map<string, SourceReadFingerprint>()};
  const value = await reads.run(collector, read);
  const rel = (file: {path:string}) => relative(root, file.path).replace(/\\/g, '/');
  return {value, skipped:[...collector.skipped.values()].map(file => ({...file,path:rel(file)})), inputs:[...collector.inputs.values()].map(file => ({...file,path:rel(file)}))};
}
