import { readFile } from 'node:fs/promises';

const tag = process.argv[2];
const version = tag?.replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('Expected a release tag in vMAJOR.MINOR.PATCH form.');
}

const readJson = async path => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
const [rootPackage, pluginPackage, rootManifest, pluginManifest, versions] = await Promise.all([
  readJson('package.json'),
  readJson('obsidian-plugin/package.json'),
  readJson('manifest.json'),
  readJson('obsidian-plugin/manifest.json'),
  readJson('versions.json'),
]);

for (const [path, metadata] of [
  ['package.json', rootPackage],
  ['obsidian-plugin/package.json', pluginPackage],
  ['manifest.json', rootManifest],
  ['obsidian-plugin/manifest.json', pluginManifest],
]) {
  if (metadata.version !== version) throw new Error(`${path} has version ${metadata.version}; expected ${version}.`);
}
if (versions[version] !== pluginManifest.minAppVersion) {
  throw new Error(`versions.json must map ${version} to ${pluginManifest.minAppVersion}.`);
}
