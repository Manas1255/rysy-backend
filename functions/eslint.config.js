const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.es6,
      },
    },
    rules: {
      "quotes": ["error", "double"],
      "indent": ["error", 2],
      "max-len": ["error", {"code": 120}],
      "no-unused-vars": ["error", {"argsIgnorePattern": "^_"}],
    },
  },
  {
    ignores: ["node_modules/**"],
  },
];
