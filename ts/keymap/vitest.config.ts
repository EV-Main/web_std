import { defineConfig } from 'vitest/config';

// The trie and normalization are DOM-free; only `keyInput` reads an event, and the fixtures feed `KeyInput`s directly.
export default defineConfig({
  test: {
    name: 'node',
    environment: 'node',
    globals: true,
    include: ['test/**/*.node.test.ts'],
  },
});
