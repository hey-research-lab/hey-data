import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { bin: 'src/bin.ts' },
    format: ['esm'],
    target: 'es2022',
    platform: 'node',
    clean: true,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'es2022',
    platform: 'node',
    dts: true,
  },
]);
