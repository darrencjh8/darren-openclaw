module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>", "<rootDir>/../workspace/skills", "<rootDir>/.."],
  testMatch: ["**/__tests__/**/*.test.js"],
  modulePathIgnorePatterns: ["<rootDir>/../workspace/skills/.*/node_modules"],
};
