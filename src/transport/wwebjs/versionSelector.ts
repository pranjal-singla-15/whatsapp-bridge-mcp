import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** `null` means "let the library pick the current WhatsApp Web build". */
export type WebVersion = string | null;

interface State {
  lastGood: WebVersion | undefined;
  cursor: number;
}

/**
 * Self-healing WhatsApp Web version selection.
 *
 * Candidates = pinned known-good builds (newest first) + the live build.
 * We start with the version that worked last time. If a start fails, the next start
 * rotates to the next candidate, so a bad WhatsApp Web release is rolled back
 * automatically, and a pin that WhatsApp has retired is skipped automatically.
 */
export class VersionSelector {
  private readonly candidates: WebVersion[];
  private state: State = { lastGood: undefined, cursor: 0 };

  constructor(
    pinned: string[],
    private readonly file: string | null,
  ) {
    this.candidates = [...new Set(pinned), null];
    this.load();
  }

  current(): WebVersion {
    return this.candidates[this.state.cursor % this.candidates.length] ?? null;
  }

  markGood(v: WebVersion): void {
    this.state.lastGood = v;
    this.state.cursor = Math.max(0, this.candidates.indexOf(v));
    this.save();
  }

  markBad(v: WebVersion): void {
    const i = this.candidates.indexOf(v);
    this.state.cursor = ((i < 0 ? this.state.cursor : i) + 1) % this.candidates.length;
    this.save();
  }

  all(): WebVersion[] {
    return [...this.candidates];
  }

  private load(): void {
    if (!this.file) return;
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<State>;
      if (s.lastGood !== undefined && this.candidates.includes(s.lastGood)) {
        this.state = { lastGood: s.lastGood, cursor: this.candidates.indexOf(s.lastGood) };
      } else if (typeof s.cursor === 'number' && s.cursor >= 0) {
        this.state.cursor = s.cursor % this.candidates.length;
      }
    } catch {
      // first run / unreadable state: start from the newest pin
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state));
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      // non-fatal: we simply lose the hint
    }
  }
}
