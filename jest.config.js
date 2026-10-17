/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: {
      branches: 55,
      functions: 75,
      lines: 70,
      statements: 70,
    },
    './src/horizon.ts': {
      branches: 60,
      functions: 70,
      lines: 70,
      statements: 70,
    },
    './src/checks.ts': {
      branches: 55,
      functions: 75,
      lines: 70,
      statements: 70,
    },
  },
  clearMocks: true,
};
