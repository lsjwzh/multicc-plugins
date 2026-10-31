#!/usr/bin/env node
'use strict';

// Packages a plugin for one-click install and adds the version to index.json.
//
//   node scripts/release.js <plugin-dir>              build the packages, print the entry (nothing is published)
//   node scripts/release.js <plugin-dir> --publish    also upload them to a GitHub Release and write index.json
//
// Options:
//   --platforms darwin-arm64,darwin-x64   default: every <binaryPlatformDir>/<os>-<arch>/ that holds the engine
//   --repo lsjwzh/multicc-plugins         where the Release lives (default: this repository, so the
//                                         plugin's own source can stay private)
//   --notes "…" --notes-en "…"           release notes shown in MultiCC
//   --out dist                            where the zips go (default: dist/)
//
// One package per <os>-<arch>, holding only what the plugin needs at run time:
// plugin.json, the folder of its ui, its own bin/<os>-<arch>/ folder, README /
// LICENSE / THIRD_PARTY / CHANGELOG, and whatever plugin.json lists under
// "files". Never its sources. Unix modes are kept (the engine must stay
// executable); links are refused.
//
// A published version never changes: the same version cannot be released
// twice. After --publish: node scripts/sign.js, node scripts/validate.js
// --signature --assets, then commit and push index.json and index.json.sig.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { validate } = require('./validate');

const ROOT = path.join(__dirname, '..');
const PLATFORM_KEY = /^(darwin|linux|win32)-(arm64|x64)$/;
const DEFAULT_REPO = 'lsjwzh/multicc-plugins';
const DOC_FILES = ['README.md', 'LICENSE', 'LICENSE.md', 'THIRD_PARTY.md', 'CHANGELOG.md'];

function parseArgs(argv) {
  const args = { dir: null, platforms: null, repo: DEFAULT_REPO, notes: null, notesEn: null, out: path.join(ROOT, 'dist'), publish: false };
  const takes = { '--platforms': 'platforms', '--repo': 'repo', '--notes': 'notes', '--notes-en': 'notesEn', '--out': 'out' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (takes[arg]) args[takes[arg]] = argv[++i];
    else if (arg === '--publish') args.publish = true;
    else if (!arg.startsWith('--') && !args.dir) args.dir = path.resolve(arg);
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!args.dir) throw new Error('usage: node scripts/release.js <plugin-dir> [--publish] [--platforms a,b] [--repo owner/name] [--notes …] [--notes-en …]');
  if (typeof args.platforms === 'string') args.platforms = args.platforms.split(',').map(item => item.trim()).filter(Boolean);
  return args;
}

function readManifest(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
  for (const key of ['id', 'version']) if (typeof manifest[key] !== 'string' || !manifest[key]) throw new Error(`plugin.json has no ${key}`);
  const engine = manifest.engine || {};
  if (engine.type !== 'command' || !engine.binary) throw new Error('plugin.json has no command engine');
  if (!engine.binaryPlatformDir) throw new Error('plugin.json must set engine.binaryPlatformDir: packages are per <os>-<arch>');
  return manifest;
}

function engineFile(dir, manifest, platform) {
  const base = path.basename(manifest.engine.binary);
  const names = platform.startsWith('win32-') && !base.endsWith('.exe') ? [base, `${base}.exe`] : [base];
  return names.map(name => path.join(dir, manifest.engine.binaryPlatformDir, platform, name)).find(file => fs.existsSync(file)) || null;
}

function platformsOf(dir, manifest, wanted) {
  const binDir = path.join(dir, manifest.engine.binaryPlatformDir);
  const found = fs.existsSync(binDir) ? fs.readdirSync(binDir).filter(name => PLATFORM_KEY.test(name)) : [];
  const list = wanted || found;
  if (!list.length) throw new Error(`no ${manifest.engine.binaryPlatformDir}/<os>-<arch>/ build found in ${dir}`);
  for (const platform of list) {
    if (!PLATFORM_KEY.test(platform)) throw new Error(`${platform} is not <os>-<arch>`);
    if (!engineFile(dir, manifest, platform)) throw new Error(`no engine binary for ${platform} in ${binDir}`);
  }
  return list.sort();
}

// Relative paths (files and folders) that go into the package for one platform.
function included(dir, manifest, platform) {
  const paths = ['plugin.json', path.join(manifest.engine.binaryPlatformDir, platform)];
  if (manifest.ui) paths.push(path.dirname(manifest.ui) === '.' ? manifest.ui : path.dirname(manifest.ui));
  for (const doc of DOC_FILES) if (fs.existsSync(path.join(dir, doc))) paths.push(doc);
  for (const extra of Array.isArray(manifest.files) ? manifest.files : []) paths.push(extra);
  for (const item of paths) {
    const resolved = path.resolve(dir, item);
    if (resolved !== dir && !resolved.startsWith(dir + path.sep)) throw new Error(`${item} is outside the plugin folder`);
    if (!fs.existsSync(resolved)) throw new Error(`${item} is listed but missing`);
  }
  return [...new Set(paths)];
}

function copyInto(source, dest) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`${source} is a link; packages hold regular files only`);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      if (name === '.DS_Store') continue;
      copyInto(path.join(source, name), path.join(dest, name));
    }
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
    fs.chmodSync(dest, stat.mode & 0o755);
  }
}

function buildPackage({ dir, manifest, platform, out }) {
  const name = `${manifest.id}-${manifest.version}-${platform}.zip`;
  const file = path.join(out, name);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-plugin-release-'));
  try {
    const top = path.join(work, `${manifest.id}-${manifest.version}`);
    for (const item of included(dir, manifest, platform)) copyInto(path.join(dir, item), path.join(top, item));
    const engine = path.join(top, path.relative(dir, engineFile(dir, manifest, platform)));
    if (!platform.startsWith('win32-')) fs.chmodSync(engine, 0o755);
    fs.mkdirSync(out, { recursive: true });
    fs.rmSync(file, { force: true });
    // Info-ZIP keeps each file's Unix mode in the archive; -X leaves out uid/gid and times.
    const zip = spawnSync('zip', ['-X', '-r', '-q', file, path.basename(top)], { cwd: work, encoding: 'utf8' });
    if (zip.error || zip.status !== 0) throw new Error(`zip failed: ${zip.error ? zip.error.message : zip.stderr}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const bytes = fs.readFileSync(file);
  return { platform, file, name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function releaseEntry({ manifest, packages, repo, tag, notes, notesEn, now = new Date() }) {
  const assets = {};
  for (const item of packages) {
    assets[item.platform] = { url: `https://github.com/${repo}/releases/download/${tag}/${item.name}`, sha256: item.sha256, size: item.size };
  }
  const release = { version: manifest.version, publishedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z') };
  if (manifest.requires) release.requires = manifest.requires;
  release.assets = assets;
  if (notes) release.notes = notes;
  if (notesEn) release.notesEn = notesEn;
  return release;
}

function compareVersions(a, b) {
  const parse = value => String(value).replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

// Adds the version to the plugin's entry (creating the entry the first time).
// Listing fields follow plugin.json, so the panel shows what the plugin says.
function addToIndex(data, manifest, release) {
  let entry = data.plugins.find(plugin => plugin.id === manifest.id);
  if (entry && entry.distribution !== 'optional') throw new Error(`${manifest.id} is listed as ${entry.distribution}, not optional`);
  if (!entry) {
    entry = { id: manifest.id, distribution: 'optional', releases: [] };
    data.plugins.push(entry);
  }
  const listing = {
    name: manifest.name, nameEn: manifest.nameEn, icon: manifest.icon, category: manifest.category,
    provides: manifest.provides, summary: manifest.summary || manifest.description,
    summaryEn: manifest.summaryEn || manifest.descriptionEn, homepage: manifest.homepage,
  };
  for (const [key, value] of Object.entries(listing)) if (value != null) entry[key] = value;
  if (entry.releases.some(item => item.version === release.version)) {
    throw new Error(`${manifest.id} ${release.version} is already listed; a published version never changes, bump the version`);
  }
  entry.releases = [release, ...entry.releases].sort((a, b) => compareVersions(b.version, a.version));
  entry.latest = entry.releases[0].version;
  // Keep the order of keys stable and readable: listing first, releases last.
  const { releases, latest, ...rest } = entry;
  const tidy = { ...rest, latest, releases };
  data.plugins[data.plugins.indexOf(entry)] = tidy;
  return tidy;
}

function gh(args) {
  const run = spawnSync('gh', args, { encoding: 'utf8' });
  if (run.error) throw new Error(`gh is not available: ${run.error.message}`);
  return run;
}

function upload({ repo, tag, manifest, packages, notes }) {
  if (gh(['release', 'view', tag, '--repo', repo]).status === 0) {
    throw new Error(`release ${tag} already exists in ${repo}; a published version never changes, bump the version`);
  }
  const title = `${manifest.name || manifest.id} ${manifest.version}`;
  const created = gh(['release', 'create', tag, ...packages.map(item => item.file), '--repo', repo, '--title', title, '--notes', notes || title]);
  if (created.status !== 0) throw new Error(`gh release create failed: ${created.stderr || created.stdout}`);
}

function main(argv) {
  const args = parseArgs(argv);
  const manifest = readManifest(args.dir);
  const platforms = platformsOf(args.dir, manifest, args.platforms);
  const tag = `${manifest.id}-v${manifest.version}`;
  const indexFile = path.join(ROOT, 'index.json');
  const data = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const existing = data.plugins.find(plugin => plugin.id === manifest.id);
  if (existing && (existing.releases || []).some(item => item.version === manifest.version)) {
    throw new Error(`${manifest.id} ${manifest.version} is already listed; a published version never changes, bump the version`);
  }

  const packages = platforms.map(platform => buildPackage({ dir: args.dir, manifest, platform, out: args.out }));
  for (const item of packages) console.log(`${item.name}  ${item.size} bytes  sha256 ${item.sha256}`);
  const release = releaseEntry({ manifest, packages, repo: args.repo, tag, notes: args.notes, notesEn: args.notesEn });
  const entry = addToIndex(data, manifest, release);
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const problems = validate(text);
  if (problems.length) throw new Error(`index.json would have ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);

  if (!args.publish) {
    console.log(`\nDry run — nothing uploaded, index.json unchanged. The entry would be:\n${JSON.stringify(entry, null, 2)}`);
    console.log(`\nTo publish: node scripts/release.js ${path.relative(process.cwd(), args.dir) || '.'} --publish`);
    return;
  }
  upload({ repo: args.repo, tag, manifest, packages, notes: args.notes });
  fs.writeFileSync(indexFile, text);
  console.log(`\nUploaded ${packages.length} package(s) to https://github.com/${args.repo}/releases/tag/${tag} and added ${manifest.version} to index.json.`);
  console.log('Next: node scripts/sign.js && node scripts/validate.js --signature --assets, then commit and push index.json and index.json.sig.');
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { parseArgs, readManifest, platformsOf, included, buildPackage, releaseEntry, addToIndex };
