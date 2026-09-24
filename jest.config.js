module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.ts'],
  // Arbeitsbäume unter .claude/worktrees tragen eigene, oft veraltete Kopien
  // von test/. Ohne diesen Ausschluss liefen sie mit: Ein Test erschien
  // doppelt, einmal grün in 0,2 s und einmal rot nach 30 s — die veraltete
  // Kopie, nicht der Test dieses Baums (24.09.2026).
  testPathIgnorePatterns: ['/node_modules/', '/\\.claude/'],
  modulePathIgnorePatterns: ['<rootDir>/\\.claude/'],
  moduleFileExtensions: ['ts', 'js', 'json'],
};
