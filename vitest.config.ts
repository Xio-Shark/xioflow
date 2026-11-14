import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    // Research fixtures under audit/interaction use node:test and run separately.
    include: ['tests/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    environment: 'node',
    testTimeout: 20000,
    fileParallelism: false,
    // The shared conformance suite (src/testing/contract-suite.ts) resolves its
    // vitest API from the environment so third parties can run it without
    // vitest (see src/testing/plain-runner.ts). Globals provide that API here.
    globals: true,
  },
  resolve: {
    alias: [
      { find: '@xioflow/kernel/surface', replacement: path.resolve(import.meta.dirname, './src/surface/index.ts') },
      { find: '@xioflow/kernel/wrap', replacement: path.resolve(import.meta.dirname, './src/wrap/index.ts') },
      { find: '@xioflow/kernel/otel', replacement: path.resolve(import.meta.dirname, './src/otel/index.ts') },
      { find: '@xioflow/kernel/isa', replacement: path.resolve(import.meta.dirname, './src/isa/public.ts') },
      { find: '@xioflow/kernel', replacement: path.resolve(import.meta.dirname, './src/index.ts') },
    ],
  },
});
