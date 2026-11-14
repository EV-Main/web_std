import { defineConfig } from 'tsup';
import type { Plugin } from 'esbuild';

// The client subpath imports the core's own dist/index.js rather than inlining a second copy of it.
const coreFromDist: Plugin = {
  name: 'core-from-dist',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/index$/ }, () => ({ path: './index.js', external: true }));
  },
};

// Re-emits ONLY the client subpath, with `clean: false`, after the main `tsup`
// run (see `tsup.config.ts`). tsup's `.d.ts` step deletes every existing
// declaration before writing its own when `clean` is set, and the main array's
// concurrent `clean: true` config finishes last — racing away `react.d.ts`.
// Running this config last (it never cleans) restores `dist/react.d.ts` without
// touching `index.d.ts` / `next.d.ts`. Kept byte-identical to config #2 of the
// main file.
export default defineConfig({
  entry: { react: 'src/react/index.tsx' },
  format: ['esm'],
  dts: true,
  clean: false,
  sourcemap: true,
  target: 'es2022',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  esbuildPlugins: [coreFromDist],
  banner: { js: '"use client";' },
});
