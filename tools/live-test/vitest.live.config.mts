import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Runs the operator live test entry point and nothing else. See investigate.live.ts.
const root = path.resolve(import.meta.dirname, '..', '..');
export default defineConfig({
  root,
  resolve: {
    alias: { '@': path.resolve(root, 'src') },
  },
  test: {
    environment: 'node',
    include: ['tools/live-test/investigate.live.ts'],
    testTimeout: 300_000,
    retry: 0,
    fileParallelism: false,
  },
});
