# Hashline Editing

Hashline editing is nav's core innovation. It solves a fundamental problem with LLM-based code editing: **files change between reads and edits**.

## The problem

Traditional approaches ask the model to reproduce old code alongside new code (search-and-replace, full file rewrites, or unified diffs). This is:

- **Wasteful** — large files mean most tokens are spent reproducing unchanged lines
- **Fragile** — if the file changed since the model last saw it, the edit may apply to the wrong location or fail silently
- **Slow** — reproducing context burns through context windows faster

## The solution

Hashline format gives each line a short content hash. The model references lines by `LINE:HASH` anchors instead of reproducing content.

### Reading

When nav reads a file, each line is prefixed with its line number and a 2-character hash (first 2 chars of xxHash32):

```
 1:f2|import { readFile } from 'fs';
 2:a1|
 3:b7|export function load(path: string) {
 4:c3|  const data = readFile(path);
 5:e9|  return JSON.parse(data);
 6:d4|}
```

### Editing

The model specifies edits by referencing anchor ranges:

```
edit lines 4:c3-5:e9 with:
  const raw = readFile(path, 'utf-8');
  if (!raw) throw new Error(`Empty file: ${path}`);
  return JSON.parse(raw);
```

Only the new content is provided — no need to reproduce the old lines.

### Verification

If the file was modified between the read and the edit:

1. nav recomputes hashes for the current file
2. The referenced anchors (`4:c3`, `5:e9`) are checked against current hashes
3. If they don't match, the edit is **rejected** with the corrected anchors
4. The model retries with the right anchors — no need to re-read the entire file

This makes editing robust against concurrent changes, auto-formatters, and other modifications.

## Hash implementation

nav uses Bun's built-in `Bun.hash.xxHash32()` for hashing. Only the first 2 hex characters of the hash are used — enough to detect changes with very low collision probability for typical file sizes. The format is inspired by [The Harness Problem](https://blog.can.ac/2026/02/12/the-harness-problem/).
