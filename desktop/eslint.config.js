import js from "@eslint/js";

const nodeGlobals = {
  console: "readonly",
  process: "readonly",
  setTimeout: "readonly",
  setInterval: "readonly",
  clearTimeout: "readonly",
  clearInterval: "readonly",
  fetch: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  atob: "readonly",
  btoa: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  import: "readonly",
  require: "readonly",
};

export default [
  js.configs.recommended,
  {
    ignores: ["node_modules/**", "release/**", "dist/**", "renderer/**", "test/**", "check-*.mjs", "test-*.mjs"],
  },
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error",
      "no-constant-condition": "warn",
      "no-empty": "warn",
      "no-useless-escape": "warn",
      "no-useless-assignment": "warn",
    },
  },
];
