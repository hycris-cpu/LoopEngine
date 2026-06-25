/**
 * Out-of-process grader — isolated, tamper-resistant scoring (Feature B).
 *
 * EurekAgent runs its grader in a separate, read-only container so the agent can
 * submit work but never see or modify the scoring logic — that is what stops
 * reward hacking. This module brings the same shape to LoopEngine: a grading
 * contract (GradeResult + is_better) with sentinel scores so an invalid
 * submission can never rank best, an IsolatedGrader that runs grading behind an
 * injected process boundary, and a real subprocess runner.
 */

/** The score and validity of one graded submission. */
export class GradeResult {
  readonly score: number;
  readonly valid: boolean;
  readonly metrics: Record<string, unknown>;

  constructor(opts: { score: number; valid?: boolean; metrics?: Record<string, unknown> }) {
    this.score = opts.score;
    this.valid = opts.valid ?? true;
    this.metrics = opts.metrics ?? {};
  }

  /** Build an invalid result whose sentinel score can never rank best. */
  static invalid(direction: string = 'maximize', metrics: Record<string, unknown> = {}): GradeResult {
    const sentinel = direction === 'maximize' ? -Infinity : Infinity;
    return new GradeResult({ score: sentinel, valid: false, metrics });
  }

  to_dict(): Record<string, unknown> {
    return { score: this.score, valid: this.valid, metrics: { ...this.metrics } };
  }
}

/**
 * Return whether `a` is a strictly better result than `b`. An invalid result is
 * never better; a valid result always beats an invalid one. Among valid results,
 * `direction` decides ('maximize' => higher is better, 'minimize' => lower).
 */
export function is_better(a: GradeResult, b: GradeResult, direction: string = 'maximize'): boolean {
  if (!a.valid) return false;
  if (!b.valid) return true;
  if (direction === 'minimize') return a.score < b.score;
  return a.score > b.score;
}

/**
 * A grading runner: given a serialized submission, return a result mapping (with
 * at least a `score`), or throw. The mapping is serializable — the runner is a
 * process boundary, so live agent objects never cross it.
 */
export type GraderRunner = (submission: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * Grades a submission via an injected (typically out-of-process) runner. The
 * submission is trusted only when the runner returns a finite numeric score: a
 * crash, a missing score, or a non-finite score all collapse to an invalid
 * sentinel result. This is the defense against a tampered or broken grader.
 */
export class IsolatedGrader {
  private readonly _run: GraderRunner;
  private readonly _direction: string;

  constructor(runner: GraderRunner, direction: string = 'maximize') {
    this._run = runner;
    this._direction = direction;
  }

  async grade(submission: Record<string, unknown>): Promise<GradeResult> {
    let raw: Record<string, unknown>;
    try {
      raw = await this._run(submission);
    } catch {
      return GradeResult.invalid(this._direction);
    }

    if (raw === null || typeof raw !== 'object' || !('score' in raw)) {
      return GradeResult.invalid(this._direction);
    }

    const score = (raw as { score: unknown }).score;
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      const metrics = (raw as { metrics?: Record<string, unknown> }).metrics ?? {};
      return GradeResult.invalid(this._direction, metrics);
    }

    return new GradeResult({
      score,
      valid: ((raw as { valid?: unknown }).valid as boolean) ?? true,
      metrics: ((raw as { metrics?: Record<string, unknown> }).metrics) ?? {},
    });
  }
}

/**
 * Build a runner that grades in a genuinely separate process. The grader script
 * reads a JSON submission from stdin and writes a JSON result to stdout. Running
 * it as a child process means the agent's process never touches the grading code.
 */
export function make_subprocess_runner(
  scriptPath: string,
  executable: string = 'bun',
  _timeout: number = 60,
): GraderRunner {
  return async (submission: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const proc = Bun.spawn([executable, scriptPath], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    proc.stdin.write(JSON.stringify(submission));
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`Grader exited ${code}: ${err}`);
    }
    return JSON.parse(out) as Record<string, unknown>;
  };
}
