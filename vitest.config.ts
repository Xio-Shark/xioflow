import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      '@xioflow/kernel': path.resolve(import.meta.dirname, './src/index.ts'),
    },
  },
});
