/**
 * Evolution checkpoint/resume — durable run state (Feature C).
 *
 * A long self-improvement run is expensive; if the process crashes you do not
 * want to throw away the completed iterations. EurekAgent persists run state and
 * resumes from a checkpoint; this gives LoopEngine the same. An
 * EvolutionCheckpoint snapshots everything needed to continue: the last finished
 * iteration, the history so far, the current (possibly evolved) source/config,
 * and the running counters. CheckpointStore reads/writes it as JSON, written
 * atomically so a crash mid-write cannot corrupt the file.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** A resumable snapshot of a LoopEngine run. */
export class EvolutionCheckpoint {
  iteration: number;
  history: Record<string, unknown>[];
  current_source: Record<string, string>;
  current_config: Record<string, unknown>;
  improvements: number;
  rejections: number;
  final_score: number;

  constructor(
    opts: {
      iteration?: number;
      history?: Record<string, unknown>[];
      current_source?: Record<string, string>;
      current_config?: Record<string, unknown>;
      improvements?: number;
      rejections?: number;
      final_score?: number;
    } = {},
  ) {
    this.iteration = opts.iteration ?? 0;
    this.history = opts.history ?? [];
    this.current_source = opts.current_source ?? {};
    this.current_config = opts.current_config ?? {};
    this.improvements = opts.improvements ?? 0;
    this.rejections = opts.rejections ?? 0;
    this.final_score = opts.final_score ?? 0.0;
  }

  to_dict(): Record<string, unknown> {
    return {
      iteration: this.iteration,
      history: this.history,
      current_source: this.current_source,
      current_config: this.current_config,
      improvements: this.improvements,
      rejections: this.rejections,
      final_score: this.final_score,
    };
  }

  static from_dict(d: Record<string, unknown>): EvolutionCheckpoint {
    return new EvolutionCheckpoint({
      iteration: (d.iteration as number) ?? 0,
      history: (d.history as Record<string, unknown>[]) ?? [],
      current_source: (d.current_source as Record<string, string>) ?? {},
      current_config: (d.current_config as Record<string, unknown>) ?? {},
      improvements: (d.improvements as number) ?? 0,
      rejections: (d.rejections as number) ?? 0,
      final_score: (d.final_score as number) ?? 0.0,
    });
  }
}

/** Reads and writes an EvolutionCheckpoint as JSON on disk. */
export class CheckpointStore {
  private readonly _path: string;

  constructor(path: string) {
    this._path = path;
  }

  exists(): boolean {
    return existsSync(this._path);
  }

  /** Persist the checkpoint atomically (write to a temp file, then rename). */
  save(checkpoint: EvolutionCheckpoint): void {
    mkdirSync(dirname(this._path), { recursive: true });
    const tmp = `${this._path}.tmp`;
    writeFileSync(tmp, JSON.stringify(checkpoint.to_dict(), null, 2), 'utf-8');
    renameSync(tmp, this._path);
  }

  /** Load the checkpoint, or return null if none has been written yet. */
  load(): EvolutionCheckpoint | null {
    if (!existsSync(this._path)) {
      return null;
    }
    const data = JSON.parse(readFileSync(this._path, 'utf-8')) as Record<string, unknown>;
    return EvolutionCheckpoint.from_dict(data);
  }
}
