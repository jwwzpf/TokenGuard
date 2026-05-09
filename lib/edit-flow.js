import fs from 'node:fs';
import path from 'node:path';
import { ensureProjectFiles, rel } from './project.js';
import { appendEvent } from './ledger.js';

export function applyEdit(projectRoot = process.cwd(), filePath, options = {}) {
  ensureProjectFiles(projectRoot);
  if (!filePath) throw new Error('Missing file path.');
  const oldString = options.oldString ?? options.old ?? options.replace;
  const newString = options.newString ?? options.new ?? options.with;
  if (oldString == null || newString == null) throw new Error('Missing --old and --new values.');
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  if (!fs.existsSync(absolute)) throw new Error(`File not found: ${filePath}`);
  const before = fs.readFileSync(absolute, 'utf8');
  const occurrences = countOccurrences(before, oldString);
  if (occurrences === 0) throw new Error('old string not found. Use `tg ctx <file> --around <text> --context 20` to inspect exact text.');
  if (!options.all && occurrences > 1) throw new Error(`old string appears ${occurrences} times. Use --all to replace all, or make --old more specific.`);
  const after = options.all ? before.split(oldString).join(newString) : before.replace(oldString, newString);
  fs.writeFileSync(absolute, after);
  const relPath = rel(projectRoot, absolute);
  appendEvent(projectRoot, { type: 'tg_edit_applied', file: relPath, occurrences: options.all ? occurrences : 1, savedTokens: 0 });
  return { file: relPath, occurrences: options.all ? occurrences : 1, beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after) };
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  return String(text).split(String(needle)).length - 1;
}
