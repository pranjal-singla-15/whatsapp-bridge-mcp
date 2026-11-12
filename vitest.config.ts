import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Real transports need a live WhatsApp session; they are covered by the canary instead.
      exclude: [
        'src/transport/wwebjs/**',
        'src/transport/baileys/**',
        'src/cli/**',
        'src/index.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 75 },
    },
  },
});
