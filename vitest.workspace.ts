import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'functions',
      environment: 'node',
      include: ['functions/__tests__/**/*.test.ts'],
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
