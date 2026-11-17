import { defineConfig, type Options } from 'tsup';

// Two passes sharing `dist/`, run one after the other (`TSUP_ONLY`): the React entry carries
// `"use client"`, the core must not, and two parallel `dts` passes race on one `dist/`.
const core: Options = {
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
};

const react: Options = {
  entry: { react: 'src/react/index.ts' },
  format: ['esm'],
  dts: true,
  clean: false,
  sourcemap: true,
  target: 'es2022',
  external: ['react', '@evinvest/api'],
  banner: { js: '"use client";' },
};

const only = process.env['TSUP_ONLY'];

export default defineConfig(only === 'core' ? [core] : only === 'react' ? [react] : [core, react]);
