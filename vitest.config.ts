import { loadEnvConfig } from "@next/env";
import { defineConfig } from "vitest/config";

const liveTestRequested = Object.entries(process.env).some(
  ([key, value]) => key.startsWith("WACRM_") && key.endsWith("_LIVE") && value === "1",
);

// Next.js loads .env.local automatically for dev/build, while Vitest does not.
// Only opt-in live tests may load the real local server environment; ordinary
// unit tests keep using the isolated dummy env below and never connect to TEST.
if (liveTestRequested) {
  loadEnvConfig(process.cwd());
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
    },
    clearMocks: true,
  },
});
