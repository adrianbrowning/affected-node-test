import { closeSync, createReadStream, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';

export const outputMemoryThreshold = 256 * 1024;

async function writeChunk(destination, chunk) {
  if (!destination.write(chunk)) await once(destination, 'drain');
}

export function createOutputBuffer({
  directory,
  name,
  threshold = outputMemoryThreshold,
}) {
  const file = join(directory, `${name}.log`);
  let chunks = [];
  let descriptor;
  let size = 0;

  function closeFile() {
    if (descriptor === undefined) return;
    closeSync(descriptor);
    descriptor = undefined;
  }

  return {
    append(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (descriptor === undefined && size + bytes.length > threshold) {
        descriptor = openSync(file, 'wx', 0o600);
        for (const buffered of chunks) writeSync(descriptor, buffered);
        chunks = [];
      }
      if (descriptor === undefined) chunks.push(bytes);
      else writeSync(descriptor, bytes);
      size += bytes.length;
    },
    async writeTo(destination) {
      if (descriptor === undefined) {
        for (const chunk of chunks) await writeChunk(destination, chunk);
        return;
      }
      closeFile();
      for await (const chunk of createReadStream(file)) await writeChunk(destination, chunk);
    },
    cleanup() {
      closeFile();
      chunks = [];
      rmSync(file, { force: true });
    },
  };
}
