// A full mongodump backup, taken before any maintenance script writes to the database — the same
// safeguard scripts/import-historical-followup.js takes, as a reusable helper.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Where the MongoDB Database Tools installer puts mongodump on Windows. The installer does not add
// this folder to PATH, and the system PATH is not a script's to change — so when 'mongodump' is not
// on PATH this location is tried directly. MONGODUMP_PATH overrides both.
const WINDOWS_DEFAULT_MONGODUMP = 'C:\\Program Files\\MongoDB\\Tools\\100\\bin\\mongodump.exe';

function resolveMongodump() {
  if (process.env.MONGODUMP_PATH) return process.env.MONGODUMP_PATH;
  const probe = spawnSync('mongodump', ['--version'], { stdio: 'ignore' });
  if (!probe.error) return 'mongodump';
  if (fs.existsSync(WINDOWS_DEFAULT_MONGODUMP)) return WINDOWS_DEFAULT_MONGODUMP;
  return null;
}

function findFiles(dir, fileName, found = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findFiles(full, fileName, found);
    else if (entry.name === fileName) found.push(full);
  });
  return found;
}

// Dumps the whole database into <rootDir>/<timestamp>-<label> and returns that folder. Throws —
// so the caller never goes on to write — if mongodump is missing, fails, or the dump does not
// contain a non-empty file for every collection in `mustContain`.
function takeBackup({ uri, rootDir, label, mustContain = [] }) {
  const mongodump = resolveMongodump();
  if (!mongodump) {
    throw new Error(
      `mongodump not found (not on PATH, and not at "${WINDOWS_DEFAULT_MONGODUMP}"; set MONGODUMP_PATH to its location) — refusing to write without a backup.`
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(rootDir, label ? `${stamp}-${label}` : stamp);
  // The URI (credentials) is passed as an argument but never printed.
  const result = spawnSync(mongodump, ['--uri', uri, '--out', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.error) {
    throw new Error(`mongodump could not be started (${result.error.code || result.error.message}) — refusing to write without a backup.`);
  }
  if (result.status !== 0) {
    throw new Error(`mongodump failed (exit ${result.status}) — refusing to write. ${String(result.stderr || '').slice(-500)}`);
  }

  const collections = mustContain.map((collection) => {
    const [file] = fs.existsSync(dir) ? findFiles(dir, `${collection}.bson`) : [];
    const bytes = file ? fs.statSync(file).size : 0;
    if (!bytes) throw new Error(`Backup at ${dir} has no data for the "${collection}" collection — refusing to write.`);
    return { collection, bytes };
  });

  return { dir, collections };
}

module.exports = { takeBackup, resolveMongodump };
