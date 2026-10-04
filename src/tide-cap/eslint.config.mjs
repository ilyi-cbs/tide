// CDS model linting (`npm run lint` / `cds lint`). TypeScript is checked by tsc;
// the UI5 apps have their own lint setups under app/*.
import cds from "@sap/eslint-plugin-cds";

export default [
  {
    ignores: [
      "node_modules/**",
      "gen/**",
      "@cds-models/**",
      "app/**/webapp/**",
      "app/**/dist/**",
      "app/**/node_modules/**",
    ],
  },
  cds.configs.recommended,
];
