import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The bundle test and the acceptance of phase B both build dist/module.js
    // and load it: one file at a time, so neither reads a bundle the other is
    // writing.
    fileParallelism: false,
  },
});
