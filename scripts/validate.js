#!/usr/bin/env node
'use strict';

// Checks index.json before it is signed and on every push.
//
//   node scripts/validate.js              format and rules
//   node scripts/validate.js --signature  also verify index.json.sig against keys.json
//   node scripts/validate.js --assets     also download every asset and check size + sha256
//
// The rules mirror what MultiCC accepts (src/plugins/catalog.js in
// lsjwzh/MultiCC), but stricter: MultiCC drops a bad entry and keeps the rest,
// this script refuses the whole list, so a bad entry never gets published.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const ID = /^[a-z0-9][a-z0-9._-]*$/;
const PLATFORM_KEY = /^(darwin|linux|win32)-(arm64|x64)$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const OSES = ['darwin', 'linux', 'win32'];
const ARCHES = ['arm64', 'x64'];
const ASSET_PREFIXES = ['https://github.com/', 'https://objects.githubusercontent.com/'];
const REQUIREMENTS = ['multicc', 'pluginApi', 'agentBuild', 'platforms', 'apps', 'permissions'];
const PERMISSIONS = ['accessibility', 'screenRecording'];
const CATEGORIES = ['channel', 'browser'];

function parseVersion(value) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(String(value ?? '').trim());
  return m ? { parts: [+m[1], +(m[2] || 0), +(m[3] || 0)], pre: m[4] || '' } : null;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] - pb.parts[i];
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

function isRange(range) {
  const text = String(range ?? '').trim();
  if (!text || text === '*') return true;
  return text.split(/\s+/).every(term => {
    const m = /^(>=|<|\^|=)?(.+)$/.exec(term);
    return Boolean(parseVersion(m[2]));
  });
}

function validate(text) {
  const problems = [];
  const fail = (where, message) => problems.push(`${where}: ${message}`);
  let data;
  try { data = JSON.parse(text); } catch (error) { return [`index.json: not JSON (${error.message})`]; }
  if (text !== `${JSON.stringify(data, null, 2)}\n`) fail('index.json', 'not formatted as 2-space JSON with a trailing newline (run scripts/sign.js, it rewrites it)');
  if (data.schema !== 1) fail('schema', 'must be 1');
  if (!Number.isFinite(Date.parse(data.updatedAt))) fail('updatedAt', 'must be an ISO date');
  else if (Date.parse(data.updatedAt) > Date.now() + 24 * 3600 * 1000) fail('updatedAt', 'is in the future');
  if (!Array.isArray(data.plugins)) return [...problems, 'plugins: must be an array'];

  const checkRequires = (where, requires) => {
    if (requires == null) return;
    if (typeof requires !== 'object' || Array.isArray(requires)) return fail(where, 'requires must be an object');
    for (const key of Object.keys(requires)) {
      if (!REQUIREMENTS.includes(key)) fail(where, `requires.${key} is unknown to MultiCC (it would show the release as unsupported)`);
    }
    for (const key of ['multicc', 'agentBuild']) {
      if (requires[key] != null && !isRange(requires[key])) fail(where, `requires.${key} is not a version range`);
    }
    if (requires.pluginApi != null && !(Number.isSafeInteger(requires.pluginApi) && requires.pluginApi > 0)) fail(where, 'requires.pluginApi must be a positive integer');
    if (requires.platforms != null) {
      if (!Array.isArray(requires.platforms) || !requires.platforms.length) fail(where, 'requires.platforms must be a non-empty array');
      for (const platform of requires.platforms || []) {
        if (!platform || !OSES.includes(platform.os)) fail(where, `requires.platforms[].os must be one of ${OSES.join(', ')}`);
        if (platform && platform.arch != null && ![].concat(platform.arch).every(arch => ARCHES.includes(arch))) fail(where, `requires.platforms[].arch must be ${ARCHES.join(' / ')}`);
        if (platform && platform.minOS != null && !parseVersion(platform.minOS)) fail(where, 'requires.platforms[].minOS is not a version');
      }
    }
    if (requires.apps != null) {
      if (!Array.isArray(requires.apps)) fail(where, 'requires.apps must be an array');
      for (const app of requires.apps || []) {
        if (!app || !BUNDLE_ID.test(String(app.id || ''))) fail(where, 'requires.apps[].id must be a bundle id');
        if (app && typeof app.name !== 'string') fail(where, 'requires.apps[].name is required');
        if (app && app.minVersion != null && !parseVersion(app.minVersion)) fail(where, 'requires.apps[].minVersion is not a version');
        if (app && app.macosPaths != null && !(Array.isArray(app.macosPaths) && app.macosPaths.every(p => typeof p === 'string' && p.startsWith('/Applications/') && p.endsWith('.app')))) {
          fail(where, 'requires.apps[].macosPaths must be /Applications/*.app');
        }
      }
    }
    if (requires.permissions != null && !(Array.isArray(requires.permissions) && requires.permissions.every(p => PERMISSIONS.includes(p)))) {
      fail(where, `requires.permissions must be among ${PERMISSIONS.join(', ')}`);
    }
  };

  const seen = new Set();
  for (const [index, plugin] of data.plugins.entries()) {
    const where = `plugins[${index}]${plugin && plugin.id ? ` (${plugin.id})` : ''}`;
    if (!plugin || !ID.test(String(plugin.id || ''))) { fail(where, 'id must match [a-z0-9][a-z0-9._-]*'); continue; }
    if (seen.has(plugin.id)) fail(where, 'duplicate id');
    seen.add(plugin.id);
    for (const key of ['name', 'nameEn', 'summary', 'summaryEn']) if (typeof plugin[key] !== 'string' || !plugin[key]) fail(where, `${key} is required`);
    if (plugin.category != null && !CATEGORIES.includes(plugin.category)) fail(where, `category must be one of ${CATEGORIES.join(', ')} (add it to MultiCC's panel labels first)`);
    if (plugin.provides != null && !(Array.isArray(plugin.provides) && plugin.provides.every(item => typeof item === 'string'))) fail(where, 'provides must be an array of strings');
    if (plugin.homepage != null && !String(plugin.homepage).startsWith('https://')) fail(where, 'homepage must be https');
    if (plugin.distribution === 'builtin') {
      if (!parseVersion(plugin.builtinSince)) fail(where, 'builtinSince (the first MultiCC version that ships it) is required');
      if (plugin.releases != null) fail(where, 'a builtin plugin has no releases (it ships with MultiCC)');
      checkRequires(where, plugin.requires);
      continue;
    }
    if (plugin.distribution !== 'optional') { fail(where, 'distribution must be builtin or optional'); continue; }
    if (!Array.isArray(plugin.releases) || !plugin.releases.length) { fail(where, 'releases must be a non-empty array'); continue; }
    const versions = new Set();
    for (const release of plugin.releases) {
      const at = `${where} release ${release && release.version}`;
      if (!release || !parseVersion(release.version)) { fail(at, 'version is not a version'); continue; }
      if (versions.has(release.version)) fail(at, 'duplicate version');
      versions.add(release.version);
      if (!Number.isFinite(Date.parse(release.publishedAt))) fail(at, 'publishedAt must be an ISO date');
      checkRequires(at, release.requires);
      const assets = release.assets || {};
      if (!Object.keys(assets).length) fail(at, 'assets must list at least one <os>-<arch> package');
      for (const [platform, asset] of Object.entries(assets)) {
        if (!PLATFORM_KEY.test(platform)) fail(at, `assets key ${platform} must be <os>-<arch>`);
        if (!asset || !ASSET_PREFIXES.some(prefix => String(asset.url || '').startsWith(prefix))) fail(at, `assets.${platform}.url must be a GitHub release download`);
        if (!/^[0-9a-f]{64}$/.test(String(asset && asset.sha256))) fail(at, `assets.${platform}.sha256 must be 64 lowercase hex characters`);
        if (!(asset && Number.isSafeInteger(asset.size) && asset.size > 0)) fail(at, `assets.${platform}.size must be the byte size`);
      }
    }
    const newest = [...versions].filter(v => parseVersion(v)).sort(compareVersions).pop();
    if (plugin.latest !== newest) fail(where, `latest must be the newest release (${newest})`);
  }
  return problems;
}

function verifySignature(text, sigText, keys) {
  const envelope = JSON.parse(sigText);
  const spki = keys[envelope.keyId];
  if (!spki) throw new Error(`index.json.sig: key ${envelope.keyId} is not in keys.json`);
  const key = crypto.createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
  if (!crypto.verify(null, Buffer.from(text), key, Buffer.from(envelope.signature, 'base64'))) {
    throw new Error('index.json.sig does not match index.json (sign it again with scripts/sign.js)');
  }
  return envelope.keyId;
}

async function checkAssets(data) {
  const problems = [];
  for (const plugin of data.plugins.filter(p => p.distribution === 'optional')) {
    for (const release of plugin.releases) {
      for (const [platform, asset] of Object.entries(release.assets || {})) {
        const where = `${plugin.id} ${release.version} ${platform}`;
        try {
          const response = await fetch(asset.url, { redirect: 'follow' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = Buffer.from(await response.arrayBuffer());
          if (body.length !== asset.size) problems.push(`${where}: size is ${body.length}, index.json says ${asset.size}`);
          const sha256 = crypto.createHash('sha256').update(body).digest('hex');
          if (sha256 !== asset.sha256) problems.push(`${where}: sha256 is ${sha256}, index.json says ${asset.sha256}`);
        } catch (error) {
          problems.push(`${where}: download failed (${error.message})`);
        }
      }
    }
  }
  return problems;
}

async function main(argv) {
  const text = fs.readFileSync(path.join(ROOT, 'index.json'), 'utf8');
  const problems = validate(text);
  if (!problems.length && argv.includes('--signature')) {
    try {
      const keyId = verifySignature(text, fs.readFileSync(path.join(ROOT, 'index.json.sig'), 'utf8'), JSON.parse(fs.readFileSync(path.join(ROOT, 'keys.json'), 'utf8')));
      console.log(`signature OK (${keyId})`);
    } catch (error) {
      problems.push(error.message);
    }
  }
  if (!problems.length && argv.includes('--assets')) problems.push(...await checkAssets(JSON.parse(text)));
  if (problems.length) {
    console.error(`index.json has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`index.json OK (${JSON.parse(text).plugins.length} plugins)`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => { console.error(error.stack || error.message); process.exit(1); });
}

module.exports = { validate, verifySignature };
