import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger.js';

/**
 * Keeps a "last known good" copy of a transport's session directory so a corrupted
 * session can be restored without re-scanning a QR code.
 *
 * Protocol (copies are only taken while the transport is NOT running, so files are consistent):
 *  - markHealthy()      after a successful connect -> writes a marker
 *  - snapshotIfHealthy() before the next start     -> if marker present, copy dir -> backup
 *  - restore()          after repeated non-logout start failures -> copy backup -> dir
 */
export class SessionVault {
  private readonly backupDir: string;
  private readonly marker: string;

  constructor(
    private readonly dir: string,
    private readonly log: Logger,
  ) {
    this.backupDir = `${dir}.last-good`;
    this.marker = join(dir, '.healthy');
  }

  async snapshotIfHealthy(): Promise<void> {
    if (!existsSync(this.marker)) return;
    try {
      await rm(this.backupDir, { recursive: true, force: true });
      await cp(this.dir, this.backupDir, {
        recursive: true,
        // Browser caches are large, regenerable and irrelevant to authentication.
        filter: (src) =>
          !/[\\/](Cache|Code Cache|GPUCache|CacheStorage|Crashpad|DawnCache|GrShaderCache)([\\/]|$)/.test(
            src,
          ),
      });
      await rm(this.marker, { force: true });
      this.log.info('session snapshot saved');
    } catch (err) {
      this.log.warn('session snapshot failed', { err });
    }
  }

  async markHealthy(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.marker, new Date().toISOString());
    } catch (err) {
      this.log.warn('could not write session health marker', { err });
    }
  }

  async hasBackup(): Promise<boolean> {
    try {
      return (await stat(this.backupDir)).isDirectory();
    } catch {
      return false;
    }
  }

  /** Returns true if a backup was restored. */
  async restore(): Promise<boolean> {
    if (!(await this.hasBackup())) return false;
    await rm(this.dir, { recursive: true, force: true });
    await cp(this.backupDir, this.dir, { recursive: true });
    this.log.warn('session restored from last-good backup');
    return true;
  }

  async destroy(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
    await rm(this.backupDir, { recursive: true, force: true });
  }
}
