// Lint config (eslint 8). Only correctness rules - formatting is left alone.
module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
  settings: { react: { version: "detect" } },
  plugins: ["react", "react-hooks"],
  extends: ["eslint:recommended", "plugin:react/recommended", "plugin:react/jsx-runtime"],
  rules: {
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
    "react/prop-types": "off",
    "no-constant-condition": ["error", { checkLoops: false }], // while (true) { ... break } is used deliberately
    "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  },
  overrides: [{ files: ["public/sw.js"], env: { serviceworker: true, browser: false } }],
  ignorePatterns: ["dist/", "node_modules/"],
};
