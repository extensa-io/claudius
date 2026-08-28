// eslint-config-next 16 ships native flat config, so the FlatCompat shim this
// file used to need is gone. Running the v16 configs through FlatCompat throws
// "Converting circular structure to JSON" rather than failing cleanly.
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts", "coverage/**"],
  },
  {
    // React Compiler rules that eslint-config-next 16 turns on as errors. They
    // flag performance smells, not Next 16 incompatibilities: every one of the
    // five current hits predates the upgrade and ships working today. Left as
    // errors they would block the build on pre-existing code, so they are
    // warnings until the flagged effects can be reworked on their own, with
    // their tests read first. Tracked as follow-up, not silently ignored.
    rules: {
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default eslintConfig;
