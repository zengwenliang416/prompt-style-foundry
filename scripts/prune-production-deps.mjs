#!/usr/bin/env node

import { access, lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const targetWorkspace = process.argv[2];
const allowedOnePic = new Set(process.argv.slice(3));
if (!['api', 'worker'].includes(targetWorkspace)) {
  throw new Error('expected target workspace api or worker');
}

for (const [relative, metadata] of Object.entries(lock.packages ?? {})) {
  if (
    !relative.startsWith('node_modules/') ||
    (metadata?.dev !== true && metadata?.devOptional !== true)
  ) {
    continue;
  }
  await rm(path.join(root, relative), { recursive: true, force: true });
}

const onePicRoot = path.join(root, 'node_modules/@onepic');
try {
  for (const entry of await readdir(onePicRoot)) {
    if (!allowedOnePic.has(entry)) {
      await rm(path.join(onePicRoot, entry), { recursive: true, force: true });
    }
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const forbiddenFile = /(?:\.test\.|\.spec\.|\.map$|\.md$|\.markdown$)/i;
const forbiddenDirectory = /^(?:test|tests|__tests__|spec|specs|testing)$/i;

async function pruneFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      try {
        await access(absolute);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await rm(absolute, { force: true });
      }
      continue;
    }
    if (stat.isDirectory()) {
      if (forbiddenDirectory.test(entry.name)) {
        await rm(absolute, { recursive: true, force: true });
      } else {
        await pruneFiles(absolute);
      }
      continue;
    }
    if (stat.isFile() && forbiddenFile.test(entry.name)) {
      await rm(absolute, { force: true });
    }
  }
}

await pruneFiles(path.join(root, 'node_modules'));

function stripDevelopmentFields(manifest) {
  const runtime = { ...manifest };
  delete runtime.devDependencies;
  delete runtime.scripts;
  return runtime;
}

const targetManifestPath = path.join(root, 'apps', targetWorkspace, 'package.json');
const targetManifest = stripDevelopmentFields(
  JSON.parse(await readFile(targetManifestPath, 'utf8')),
);
await writeFile(targetManifestPath, `${JSON.stringify(targetManifest, null, 2)}\n`);
await writeFile(path.join(root, 'package.json'), `${JSON.stringify(targetManifest, null, 2)}\n`);

for (const workspace of allowedOnePic) {
  const manifestPath = path.join(root, 'packages', workspace, 'package.json');
  const manifest = stripDevelopmentFields(JSON.parse(await readFile(manifestPath, 'utf8')));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
