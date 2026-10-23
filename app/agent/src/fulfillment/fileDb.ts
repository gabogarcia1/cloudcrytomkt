/**
 * Tiny JSON-file persistence for local dev (orders, tasks, credits).
 * Atomic writes (temp file + rename). Reads and writes are synchronous, so a
 * read-modify-write in one call cannot interleave with another request in
 * this process. Production: replace with a durable store (see store.ts).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function dataPath(envName: string, file: string): string {
  return process.env[envName] ?? fileURLToPath(new URL(`../../.data/${file}`, import.meta.url));
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
