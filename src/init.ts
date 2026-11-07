import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomically } from './cache.ts';

const config = {
  $schema: './node_modules/affected-node-test/schema/affected-node-test.schema.json',
};
const scripts = {
  'test:affected': 'affected-node-test affected',
  'test:baseline': 'affected-node-test baseline',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sameConfig(value: unknown) {
  return isRecord(value) && Object.keys(value).length === 1 && value.$schema === config.$schema;
}

export function initializeProject(root: string, { write }: { write: boolean }) {
  const output: string[] = [];
  const conflicts: string[] = [];
  let changes = 0;

  const configPath = join(root, 'affected-node-test.config.json');
  if (!existsSync(configPath)) {
    changes += 1;
    output.push(`${write ? 'Created' : 'Would create'} affected-node-test.config.json`);
    if (write) writeJsonAtomically(configPath, config);
  } else {
    let existingConfig: unknown;
    try {
      existingConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      existingConfig = undefined;
    }
    if (!sameConfig(existingConfig)) {
      conflicts.push('Conflict: affected-node-test.config.json already exists with different content; left unchanged.');
    }
  }

  const ignorePath = join(root, '.gitignore');
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  const ignoreLines = ignore.split(/\r?\n/);
  if (!ignoreLines.includes('.affected-tests/')) {
    changes += 1;
    output.push(`${write ? 'Updated' : 'Would update'} .gitignore: ${write ? 'added' : 'add'} .affected-tests/`);
    if (write) {
      const separator = ignore.length && !ignore.endsWith('\n') ? '\n' : '';
      writeFileSync(ignorePath, `${ignore}${separator}.affected-tests/\n`);
    }
  }

  const packagePath = join(root, 'package.json');
  if (!existsSync(packagePath)) {
    conflicts.push('Conflict: package.json does not exist; package scripts were not proposed.');
  } else {
    const parsedPackage: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (!isRecord(parsedPackage)) throw new Error('package.json must contain an object.');
    const existingScripts = parsedPackage.scripts;
    if (existingScripts !== undefined && !isRecord(existingScripts)) {
      conflicts.push('Conflict: package.json scripts must be an object; left unchanged.');
    } else {
      const packageScripts = existingScripts ?? {};
      let packageChanged = false;
      for (const [name, value] of Object.entries(scripts)) {
        const existing = packageScripts[name];
        if (existing === undefined) {
          changes += 1;
          packageChanged = true;
          output.push(`${write ? 'Updated' : 'Would update'} package.json: ${write ? 'added' : 'add'} script ${name}`);
          packageScripts[name] = value;
        } else if (existing !== value) {
          conflicts.push(`Conflict: package.json script ${name} is already ${JSON.stringify(existing)}; left unchanged.`);
        }
      }
      if (write && packageChanged) {
        parsedPackage.scripts = packageScripts;
        writeJsonAtomically(packagePath, parsedPackage);
      }
    }
  }

  if (!changes && !conflicts.length) output.push('No changes needed.');
  if (!write && changes) output.push('Preview only; rerun with --write to apply changes.');
  return { conflicts, output };
}
