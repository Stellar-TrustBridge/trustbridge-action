const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
const repoRoot = path.resolve(__dirname, '..');

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function stripFileUrl(value) {
  return value.replace(/^file:\/\//i, '');
}

function repoRelativePath(value, mapPath) {
  const original = toPosix(value);
  const withoutUrl = stripFileUrl(original);
  const hasDrive = /^[A-Za-z]:\//.test(withoutUrl);
  const isAbsolute = withoutUrl.startsWith('/') || hasDrive;
  const candidate = hasDrive ? withoutUrl.slice(3) : withoutUrl;

  if (isAbsolute) {
    const normalizedRoot = toPosix(repoRoot).replace(/^[A-Za-z]:\//, '');
    if (candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`)) {
      return candidate.slice(normalizedRoot.length).replace(/^\/+/, '');
    }
    const repoMarker = `${path.basename(repoRoot)}/`;
    const repoIndex = candidate.indexOf(repoMarker);
    if (repoIndex >= 0) return candidate.slice(repoIndex + repoMarker.length);
    if (candidate === 'src' || candidate.endsWith('/src')) return 'src';
    if (candidate === 'dist' || candidate.endsWith('/dist')) return 'dist';
    const srcIndex = candidate.indexOf('/src/');
    if (srcIndex >= 0) return candidate.slice(srcIndex + 1);
    const distIndex = candidate.indexOf('/dist/');
    if (distIndex >= 0) return candidate.slice(distIndex + 1);
    return candidate.replace(/^\/+/, '');
  }

  if (!withoutUrl.startsWith('./') && !withoutUrl.startsWith('../')) return withoutUrl;
  return toPosix(path.relative(repoRoot, path.resolve(path.dirname(mapPath), candidate)));
}

function normalizeMap(map, mapPath) {
  const normalized = { ...map };
  if (Array.isArray(map.sources)) {
    normalized.sources = map.sources.map((source) => repoRelativePath(source, mapPath));
  }
  for (const field of ['sourceRoot', 'file']) {
    if (typeof map[field] === 'string' && map[field] !== '') {
      normalized[field] = repoRelativePath(map[field], mapPath);
    }
  }
  return normalized;
}

function normalizeMaps(directory = distDir) {
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith('.map')) continue;
    const filePath = path.join(directory, name);
    const original = fs.readFileSync(filePath, 'utf8');
    const map = JSON.parse(original);
    const normalizedMap = normalizeMap(map, filePath);
    const normalized = JSON.stringify(normalizedMap) === JSON.stringify(map)
      ? original
      : JSON.stringify(normalizedMap);
    if (normalized !== original) {
      fs.writeFileSync(filePath, normalized, 'utf8');
      console.log(`normalized source paths in ${path.relative(repoRoot, filePath)}`);
    }
  }
}

if (require.main === module) normalizeMaps();

module.exports = { normalizeMap, normalizeMaps, repoRelativePath };
