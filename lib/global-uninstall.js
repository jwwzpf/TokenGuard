import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';

const BIN_NAMES = process.platform === 'win32'
  ? ['token-guard.cmd', 'tg.cmd', 'token-guard.ps1', 'tg.ps1', 'token-guard', 'tg']
  : ['token-guard', 'tg'];

const PACKAGE_NAMES = [
  '@jwwzpf/token-guard',
  '@codingdaddy/token-guard'
];

export function uninstallGlobalCli(options = {}) {
  const force = Boolean(options.force);
  const skipNpm = Boolean(options.skipNpm);
  const dryRun = Boolean(options.dryRun);
  const result = {
    npmUninstall: [],
    removed: [],
    skipped: [],
    errors: [],
    binDirs: [],
    dryRun
  };

  if (!skipNpm && !dryRun) {
    for (const pkg of PACKAGE_NAMES) {
      const npmResult = tryNpmUninstall(pkg);
      result.npmUninstall.push(npmResult);
    }
  }

  const dirs = findCandidateBinDirs();
  result.binDirs = [...dirs];

  for (const dir of dirs) {
    for (const name of BIN_NAMES) {
      const file = path.join(dir, name);

      if (!fs.existsSync(file)) continue;

      const safety = isTokenGuardExecutable(file);

      if (!safety.safe && !force) {
        result.skipped.push({
          file,
          reason: safety.reason || 'not recognized as Token Guard executable'
        });
        continue;
      }

      if (dryRun) {
        result.removed.push({
          file,
          reason: `[dry-run] would remove · ${safety.reason || (force ? 'force' : 'recognized')}`
        });
        continue;
      }

      try {
        fs.unlinkSync(file);
        result.removed.push({
          file,
          reason: safety.reason || (force ? 'removed by force' : 'removed')
        });
      } catch (err) {
        result.errors.push({
          file,
          message: err.message
        });
      }
    }
  }

  return result;
}

export function formatGlobalUninstallResult(result) {
  const lines = [];

  lines.push(result.dryRun
    ? 'Token Guard global CLI cleanup [DRY RUN — no files removed]'
    : 'Token Guard global CLI cleanup');
  lines.push('');

  const npmRows = result.npmUninstall || [];
  const successfulNpm = npmRows.filter(row => row.ok && row.installed !== false);
  const failedNpm = npmRows.filter(row => !row.ok && row.installed !== false);

  if (successfulNpm.length) {
    lines.push('npm global packages removed:');
    for (const row of successfulNpm) {
      lines.push(`- ${row.packageName}`);
    }
    lines.push('');
  }

  if (failedNpm.length) {
    lines.push('npm global packages that could not be removed:');
    for (const row of failedNpm) {
      lines.push(`- ${row.packageName}: ${truncate(row.message, 200)}`);
    }
    lines.push('  Try: sudo npm uninstall -g <package>');
    lines.push('');
  }

  if (result.removed?.length) {
    lines.push(result.dryRun ? 'Global command files that would be removed:' : 'Global command files removed:');
    for (const row of result.removed) {
      lines.push(`- ${row.file}`);
    }
    lines.push('');
  }

  if (result.skipped?.length) {
    lines.push('Skipped files that were not safely recognized as Token Guard:');
    for (const row of result.skipped) {
      lines.push(`- ${row.file} (${row.reason})`);
    }
    lines.push('');
    lines.push('If you are sure these are old Token Guard leftovers, run:');
    lines.push('  token-guard uninstall-global --force');
    lines.push('');
  }

  if (result.errors?.length) {
    lines.push('Errors:');
    for (const row of result.errors) {
      lines.push(`- ${row.file}: ${row.message}`);
    }
    lines.push('');
    lines.push('If this is a permission problem, remove the files manually or use sudo:');
    lines.push('  sudo rm -f /opt/homebrew/bin/token-guard /opt/homebrew/bin/tg');
    lines.push('');
  }

  if (!result.removed?.length && !successfulNpm.length && !result.errors?.length) {
    lines.push('No global Token Guard CLI files were found.');
    lines.push('');
  }

  lines.push('Project-level Token Guard files are not affected by this command.');
  lines.push('To remove Token Guard from a project, run this inside the project root:');
  lines.push('  token-guard uninstall');

  return lines.join('\n');
}

function tryNpmUninstall(packageName) {
  try {
    const stdout = childProcess.execFileSync('npm', ['uninstall', '-g', packageName], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8'
    }) || '';

    const installed = !/up to date|removed 0 packages|no packages to remove/i.test(stdout);

    return {
      packageName,
      ok: true,
      installed
    };
  } catch (err) {
    const message = String(err.stderr || err.message || err);
    const notInstalled = /ENOENT|not installed|no such package/i.test(message);

    return {
      packageName,
      ok: false,
      installed: !notInstalled,
      message
    };
  }
}

function findCandidateBinDirs() {
  const dirs = new Set();

  const npmPrefix = getNpmPrefix();

  if (npmPrefix) {
    if (process.platform === 'win32') {
      dirs.add(npmPrefix);
    } else {
      dirs.add(path.join(npmPrefix, 'bin'));
    }
  }

  const argvBin = process.argv?.[1] ? path.dirname(process.argv[1]) : '';
  if (argvBin) dirs.add(argvBin);

  const pathDirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);

  for (const dir of pathDirs) {
    if (
      dir.includes('npm') ||
      dir.includes('node') ||
      dir.includes('homebrew') ||
      dir.endsWith('/bin') ||
      dir.endsWith('\\npm')
    ) {
      dirs.add(dir);
    }
  }

  if (process.platform === 'darwin') {
    dirs.add('/opt/homebrew/bin');
    dirs.add('/usr/local/bin');
  }

  if (process.platform !== 'win32') {
    dirs.add(path.join(os.homedir(), '.npm-global', 'bin'));
  }

  return [...dirs].filter(Boolean);
}

function getNpmPrefix() {
  try {
    return childProcess.execFileSync('npm', ['prefix', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

function isTokenGuardExecutable(file) {
  let stat;

  try {
    stat = fs.lstatSync(file);
  } catch {
    return {
      safe: false,
      reason: 'missing'
    };
  }

  if (stat.isSymbolicLink()) {
    try {
      const target = fs.readlinkSync(file);
      const resolved = path.resolve(path.dirname(file), target);

      if (looksLikeTokenGuardPath(target) || looksLikeTokenGuardPath(resolved)) {
        return {
          safe: true,
          reason: `symlink to ${target}`
        };
      }

      return {
        safe: false,
        reason: `symlink target not recognized: ${target}`
      };
    } catch {
      return {
        safe: false,
        reason: 'unreadable symlink'
      };
    }
  }

  if (!stat.isFile()) {
    return {
      safe: false,
      reason: 'not a regular file'
    };
  }

  try {
    const content = fs.readFileSync(file, 'utf8').slice(0, 20000);

    if (
      content.includes('Token Guard') &&
      (
        content.includes('handleHook') ||
        content.includes('token-guard install') ||
        content.includes('@jwwzpf/token-guard') ||
        content.includes('@codingdaddy/token-guard')
      )
    ) {
      return {
        safe: true,
        reason: 'file content recognized as Token Guard'
      };
    }

    if (
      content.includes('bin/token-guard.js') &&
      (
        content.includes('@jwwzpf/token-guard') ||
        content.includes('@codingdaddy/token-guard')
      )
    ) {
      return {
        safe: true,
        reason: 'npm shim recognized as Token Guard'
      };
    }

    return {
      safe: false,
      reason: 'file content not recognized'
    };
  } catch {
    return {
      safe: false,
      reason: 'unreadable file'
    };
  }
}

function truncate(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

function looksLikeTokenGuardPath(value) {
  const s = String(value || '').toLowerCase();

  return (
    s.includes('@jwwzpf/token-guard') ||
    s.includes('@codingdaddy/token-guard') ||
    s.includes('tokenguard') ||
    s.includes('token-guard')
  );
}