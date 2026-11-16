import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'node',
    environment: 'node',
    globals: true,
    include: ['test/**/*.node.test.ts'],
    typecheck: { enabled: true, include: ['test/**/*.node.test.ts'] },
  },
});
