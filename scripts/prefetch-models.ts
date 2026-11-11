// Downloads every model bundle the server uses into NETRA_MODELS_DIR, so the server can run
// offline. Used by docker/Dockerfile at build time. Exits non-zero if any bundle fails, so a
// build cannot produce an image that is missing a model.
//
//   NETRA_MODELS_DIR=/tmp/models npx tsx scripts/prefetch-models.ts

import { getLineDetector, getRecognizer } from "../src/pipeline.js";

async function main(): Promise<void> {
  const started = Date.now();
  await getLineDetector();
  await getRecognizer("ar");
  await getRecognizer("blockwise");
  console.log(`Netra OCR models downloaded in ${Math.round((Date.now() - started) / 1000)} s`);
}

main().catch((err) => {
  console.error("Model download failed:", err?.message || err);
  process.exit(1);
});
