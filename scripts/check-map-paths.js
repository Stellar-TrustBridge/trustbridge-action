const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function pathError(value) {
  if (value.includes('\\')) return 'contains a backslash';
  if (/^[A-Za-z]:/.test(value)) return 'contains a drive-letter path';
  if (/^file:\/\//i.test(value)) return 'contains a file:// URL';
  if (value.startsWith('/')) return 'is absolute';
  if (value.startsWith('./')) return 'is not repo-relative';
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../')) return 'escapes the repo root';
  if (value === '') return 'is not repo-relative';
  return null;
}

function isVendorSource(source) {
  return source === 'node_modules' || source.startsWith('node_modules/');
}

function sourceMapErrors(map, mapName) {
  const errors = [];
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    return [`${mapName}: source map must be an object`];
  }
  if (map.version !== 3) errors.push(`${mapName}: source map version must be 3`);
  if (typeof map.mappings !== 'string') errors.push(`${mapName}: mappings must be a string`);
  if (!Array.isArray(map.sources) || map.sources.length === 0) {
    errors.push(`${mapName}: sources must be a non-empty array`);
    return errors;
  }

  const sourceRoot = typeof map.sourceRoot === 'string' ? map.sourceRoot : '';
  const applicationSources = map.sources.filter((source) => {
    if (typeof source !== 'string' || source === '') return false;
    const resolved = toPosix(path.posix.join(sourceRoot, source));
    return !isVendorSource(resolved) && (resolved === 'src' || resolved.startsWith('src/'));
  });
  const hasOnlyVendorSources = map.sources.every((source) => {
    if (typeof source !== 'string') return false;
    return isVendorSource(toPosix(path.posix.join(sourceRoot, source)));
  });
  if (applicationSources.length === 0 && !hasOnlyVendorSources) {
    errors.push(`${mapName}: sources must point at src/`);
  }
  return errors;
}

function checkMapPaths(directory = distDir) {
  if (!fs.existsSync(directory)) throw new Error(`dist directory is missing: ${directory}`);
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.map'));
  if (files.length === 0) throw new Error(`no source maps found in ${directory}`);

  const errors = [];
  for (const name of files) {
    const filePath = path.join(directory, name);
    let map;
    try {
      map = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      errors.push(`${path.relative(repoRoot, filePath)}: invalid JSON (${error.message})`);
      continue;
    }
    errors.push(...sourceMapErrors(map, path.relative(repoRoot, filePath)));
    for (const field of ['sources', 'sourceRoot', 'file']) {
      const values = field === 'sources' ? map[field] : [map[field]];
      if (!Array.isArray(values)) continue;
      values.forEach((value, index) => {
        if (typeof value !== 'string' || value === '') return;
        const reason = pathError(value);
        if (reason) {
          const entry = field === 'sources' ? `${field}[${index}]` : field;
          errors.push(`${path.relative(repoRoot, filePath)} ${entry} ${reason}: ${value}`);
        }
      });
    }
  }
  if (errors.length) {
    throw new Error(`${errors.join('\n')}\nRebuild on Linux / run refresh-dist.`);
  }
  return files.length;
}

if (require.main === module) {
  try {
    const count = checkMapPaths();
    console.log(`checked ${count} source map(s)`);
  } catch (error) {
    console.error(`Source-map path check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { checkMapPaths, pathError, sourceMapErrors };