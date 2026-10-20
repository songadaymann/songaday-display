// Composes the manifest from STATE and writes PUBLISH/wall/current.json plus its immutable rollback
// copy PUBLISH/wall/manifests/<songCount>-<hash>.json. A no-op when nothing changed.
//
//   npm run wall:manifest
import { withLock, writeManifest } from './lib/manifest.mjs';

await withLock(async () => {
  const { manifest: m, changed, files } = writeManifest();
  console.log(`wall:manifest ${changed ? 'updated' : 'unchanged'}: songCount ${m.songCount}, updatedAt ${m.updatedAt}`);
  console.log(`  overrides ${Object.keys(m.overrides).length}, missingArt [${m.missingArt.join(', ')}], noGif ${m.noGif.length}, stillRev ${Object.keys(m.stillRev).length}, gifRev ${Object.keys(m.gifRev).length}`);
  console.log(`  catalog: ${m.catalog ? `${m.catalog.index.length} index + ${m.catalog.detail.length} detail chunks of ${m.catalog.chunkSize}` : 'none yet (STATE/catalog.json missing; run npm run catalog:build)'}`);
  console.log(`  ${files.current}\n  ${files.history}`);
}).catch((err) => {
  console.error(`wall:manifest failed: ${err.message}`);
  process.exitCode = 1;
});
