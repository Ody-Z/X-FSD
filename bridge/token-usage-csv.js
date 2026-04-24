import path from 'node:path';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import {
  buildTokenUsageCsvHeader,
  buildTokenUsageCsvRow
} from '../lib/token-usage.js';

const DEFAULT_TOKEN_USAGE_CSV_PATH = process.env.XGA_TOKEN_USAGE_CSV ||
  '/tmp/xga-token-usage.csv';

function createTokenUsageCsvLogger(csvPath = DEFAULT_TOKEN_USAGE_CSV_PATH) {
  let headerPromise = null;

  async function ensureHeader() {
    if (headerPromise) return headerPromise;

    headerPromise = (async () => {
      await mkdir(path.dirname(csvPath), { recursive: true });
      let existing = '';
      try {
        existing = await readFile(csvPath, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }

      if (!existing.trim()) {
        await appendFile(csvPath, `${buildTokenUsageCsvHeader()}\n`, 'utf8');
      }
    })().catch((error) => {
      headerPromise = null;
      throw error;
    });

    return headerPromise;
  }

  async function append(entry) {
    await ensureHeader();
    await appendFile(csvPath, `${buildTokenUsageCsvRow(entry)}\n`, 'utf8');
  }

  return {
    csvPath,
    append
  };
}

export {
  DEFAULT_TOKEN_USAGE_CSV_PATH,
  createTokenUsageCsvLogger
};
