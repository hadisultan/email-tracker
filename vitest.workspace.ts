import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'functions',
      environment: 'node',
      include: ['functions/__tests__/**/*.test.ts'],
      // Many of these tests share the local Supabase database and the
      // SEED_USER_ID seed row; running them sequentially keeps deletes
      // and inserts from racing across files. Within each file, vitest
      // already runs tests in declared order.
      fileParallelism: false,
    },
  },
  {
    test: {
      name: 'extension',
      environment: 'jsdom',
      include: ['extension/__tests__/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'dashboard',
      environment: 'jsdom',
      include: ['dashboard/__tests__/**/*.test.{ts,tsx}'],
    },
  },
]);
