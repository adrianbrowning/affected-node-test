#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli-app.ts';

await runCli(fileURLToPath(import.meta.url));
