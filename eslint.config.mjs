// eslint.config.mjs
import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Ignore build artifacts + deps
  {
    ignores: ["node_modules/**", ".next/**", "dist/**", "build/**", "out/**"],
  },

  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript recommended rules (non-type-aware)
  ...tseslint.configs.recommended,

  // --- Node scripts (fixes: 'console' is not defined) ---
  {
    files: ["scripts/**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // --- App source (Next + React) ---
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node, // Next files can run in node (route handlers, server components)
      },
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
      "@next/next": nextPlugin,
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      // Next recommendations
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,

      // React Hooks (keep the important ones)
      ...reactHooks.configs.recommended.rules,

      // Turn off the noisy/false-positive rule you're hitting
      "react-hooks/set-state-in-effect": "off",
    },
  },
);