module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: { node: true, es2022: true },
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      },
    ],
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "undici",
            message:
              "Import undici ONLY inside src/lib/portal/. Use PortalApiClient or DownloadClient from there.",
          },
        ],
      },
    ],
  },
  overrides: [
    {
      files: ["src/lib/portal/**/*.ts", "tests/**/*.ts"],
      rules: { "no-restricted-imports": "off" },
    },
    {
      files: ["tests/**/*.ts"],
      rules: { "@typescript-eslint/no-explicit-any": "off" },
    },
  ],
};
