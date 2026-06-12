/**
 * Java CLI bridge for Portfolio Performance XML manipulation.
 * Ported 1:1 from src/pp_client/java_bridge.py
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const JAVA_CMD = 'java';
const JAR_PATH = process.env.PP_JAR_PATH || 'pp-cli.jar';

/**
 * Execute a Java CLI command for Portfolio Performance.
 * @param {string} command - CLI command (sync, import, export)
 * @param {string[]} args - Additional arguments
 * @returns {Promise<{success: boolean, output: string, error?: string}>}
 */
export async function runJavaCLI(command, args = []) {
  try {
    const { stdout, stderr } = await execFileAsync(JAVA_CMD, ['-jar', JAR_PATH, command, ...args], {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { success: true, output: stdout, error: stderr || undefined };
  } catch (err) {
    return { success: false, output: err.stdout || '', error: err.stderr || err.message };
  }
}

/** Sync portfolio data to PP XML file */
export async function syncPortfolio(xmlPath) {
  return runJavaCLI('sync', ['--file', xmlPath]);
}

/** Import transactions from CSV to PP */
export async function importTransactions(csvPath, xmlPath) {
  return runJavaCLI('import', ['--csv', csvPath, '--file', xmlPath]);
}

/** Export PP data to CSV */
export async function exportTransactions(xmlPath, outputPath) {
  return runJavaCLI('export', ['--file', xmlPath, '--output', outputPath]);
}
