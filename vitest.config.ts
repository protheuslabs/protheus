import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['client/tests/vitest/**/*.test.ts', 'tests/vitest/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      enabled: true,
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage/ts',
      include: [
        'client/systems/conduit/conduit-client.ts',
        'client/lib/direct_conduit_lane_bridge.js'
      ]
    }
  }
});
