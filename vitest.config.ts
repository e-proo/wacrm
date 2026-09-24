import { loadEnvConfig } from "@next/env";
import { defineConfig } from "vitest/config";

const liveTestRequested = Object.entries(process.env).some(
  ([key, value]) => key.startsWith("WACRM_") && key.endsWith("_LIVE") && value === "1",
);

// Next.js loads .env.local automatically for dev/build, while Vitest does not.
// Only opt-in live tests may load the real local server environment; ordinary
// unit tests keep using the isolated dummy env below and never connect to TEST.
if (liveTestRequested) {
  const previousNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'development'
  try {
    // Next intentionally skips .env.local when NODE_ENV=test. Live verification
    // must use the same local server environment as `next dev`, so load it
    // under the development mode and immediately restore Vitest's test mode.
    loadEnvConfig(process.cwd(), true)
  } finally {
    process.env.NODE_ENV = previousNodeEnv
  }
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
