/**
 * OneDrive sync utilities.
 * Ported 1:1 from src/onedrive_download.py and src/onedrive_upload.py
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const ONEDRIVE_DIR = process.env.ONEDRIVE_DATA_DIR || '/data/onedrive';

/** Pull the latest Portfolio.portfolio from OneDrive */
export async function pullFromOneDrive(remotePath = 'Portfolio/Portfolio.portfolio') {
  const localPath = `${ONEDRIVE_DIR}/${remotePath}`;
  try {
    // The OneDrive sync is handled by the onedrive Docker container
    // which syncs /onedrive/data to the host volume
    const { readFileSync } = await import('fs');
    return { success: true, data: readFileSync(localPath, 'utf8'), path: localPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** Push updated PP XML to OneDrive */
export async function pushToOneDrive(localPath, remotePath = 'Portfolio/Portfolio.portfolio') {
  try {
    const { copyFileSync } = await import('fs');
    const destPath = `${ONEDRIVE_DIR}/${remotePath}`;
    copyFileSync(localPath, destPath);
    return { success: true, path: destPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
