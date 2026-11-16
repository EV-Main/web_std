import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: { name: 'node', environment: 'node', include: ['test/**/*.node.test.ts'], globals: true },
  },
  {
    test: { name: 'react', environment: 'jsdom', include: ['test/**/*.react.test.tsx'], globals: true, setupFiles: ['./test/setup.ts'] },
    esbuild: { jsx: 'automatic' },
  },
]);
