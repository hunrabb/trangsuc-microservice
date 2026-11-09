import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { classifyError, PermanentError } from '@jewelry/common';
import { z } from 'zod';

interface FileOptions {
  input: string;
  audit: string;
  checkpoint: string;
  apply?: boolean;
  batchSize?: number;
}

export interface BackfillResult {
  orderId?: string;
  status: string;
  missingCost?: boolean;
  reason?: string;
}

/** IO độc lập DB để kiểm chứng cursor thật; callback chỉ trả về sau commit. */
export async function importBackfillFile(
  options: FileOptions,
  processRecord: (raw: unknown, apply: boolean) => Promise<BackfillResult>,
) {
  const input = resolve(options.input);
  const audit = resolve(options.audit);
  const checkpoint = resolve(options.checkpoint);
  if (new Set([input, audit, checkpoint]).size !== 3)
    throw new Error('input/audit/checkpoint phải là ba file khác nhau');
  const limit = z
    .number()
    .int()
    .min(1)
    .max(500)
    .parse(options.batchSize ?? 100);
  if ((await stat(input)).size > 32 * 1024 * 1024)
    throw new Error('Batch vượt 32 MiB; giảm batch export');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(input)) hash.update(chunk);
  const fileHash = hash.digest('hex');
  const mode = options.apply ? 'APPLY' : 'DRY_RUN';
  let after = 0;
  try {
    const saved = z
      .object({ fileHash: z.string(), mode: z.string(), line: z.number().int().nonnegative() })
      .parse(JSON.parse(await readFile(checkpoint, 'utf8')));
    if (saved.fileHash !== fileHash || saved.mode !== mode)
      throw new Error('Checkpoint không khớp file hoặc mode; dùng file checkpoint khác');
    after = saved.line;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const counts: Record<string, number> = {};
  let line = 0;
  let processed = 0;
  let incompleteCost = 0;
  const log = await open(audit, 'a', 0o600);
  const stream = createReadStream(input);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const content of lines) {
      line++;
      if (line <= after) continue;
      if (processed >= limit) break;
      let result: BackfillResult;
      try {
        if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('Dòng vượt 1 MiB');
        result = await processRecord(JSON.parse(content), options.apply ?? false);
      } catch (error) {
        if (classifyError(error) === 'TRANSIENT') throw error;
        if (
          error instanceof z.ZodError ||
          error instanceof SyntaxError ||
          error instanceof PermanentError ||
          (error as Error).message === 'Dòng vượt 1 MiB'
        ) {
          result = {
            status: 'INVALID_OR_CONFLICT',
            reason: 'INVALID_INPUT_OR_CONCURRENT_CONFLICT',
          };
        } else {
          throw error;
        }
      }
      counts[result.status] = (counts[result.status] ?? 0) + 1;
      if (result.missingCost) incompleteCost++;
      processed++;
      await log.write(
        JSON.stringify({ at: new Date().toISOString(), fileHash, mode, line, ...result }) + '\n',
      );
      await log.sync();
      const temp = `${checkpoint}.tmp-${process.pid}`;
      await writeFile(temp, JSON.stringify({ fileHash, mode, line }), { mode: 0o600 });
      await rename(temp, checkpoint);
      after = line;
    }
    return {
      mode,
      fileHash,
      processed,
      counts,
      incompleteCost,
      nextLine: after,
      possiblyMore: processed === limit,
    };
  } finally {
    lines.close();
    stream.destroy();
    await log.close();
  }
}
