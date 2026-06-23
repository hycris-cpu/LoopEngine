/**
 * CodeMod represents a PROPOSED SELF-MODIFICATION — a change the agent wants to make to itself.
 *
 * Plain English: Imagine you're a chef trying to improve your recipe. A CodeMod is
 * like a recipe modification note:
 * - target_file: Which recipe card to change (e.g., "loopengine/processors/context/system_prompt.py")
 * - description: What the change is (e.g., "Add step counting to the system prompt")
 * - diff: The exact text change (like showing the old and new recipe)
 * - rationale: Why you think this will help (e.g., "The agent keeps repeating itself")
 * - expected_impact: What metric should improve (e.g., "Efficiency should go up 10%")
 *
 * The evolution layer generates CodeMods, tests them in a sandbox, and only applies
 * them if they actually improve performance.
 *
 * Key safety principle: Every CodeMod has an is_safe() method that checks for
 * dangerous patterns like os.system, rm -rf, or dynamic imports. Unsafe mods
 * are rejected before they ever touch the real codebase.
 */

// ---------------------------------------------------------------------------
// Dangerous patterns — things we NEVER allow in a self-modification
// ---------------------------------------------------------------------------

// Plain English: These are the "red flags" that make a modification unsafe.
// Like a recipe change that says "add bleach" — we reject it immediately,
// no matter how good the rest of the change looks.
const DANGEROUS_PATTERNS: RegExp[] = [
  /os\.system\s*\(/,
  /rm\s+-rf\b/,
  /__import__\s*\(\s*['"]os['"]/,
  /__import__\s*\(\s*['"]subprocess['"]/,
  /subprocess\.(call|run|Popen|check_output)\s*\(/,
  /\bexec\s*\(/,
  /\beval\s*\(/,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Replace the first occurrence of `search` in `content` with `replace`.
 *
 * This mirrors Python's `str.replace(old, new, 1)` behavior, ensuring each
 * diff hunk only modifies a single location in the file.
 */
function replaceFirst(content: string, search: string, replace: string): string {
  const idx = content.indexOf(search);
  if (idx === -1) {
    return content;
  }
  return content.slice(0, idx) + replace + content.slice(idx + search.length);
}

// ---------------------------------------------------------------------------
// CodeMod — a single proposed change
// ---------------------------------------------------------------------------

/**
 * A single proposed self-modification — one "recipe change note".
 *
 * Plain English: This is the atomic unit of self-improvement. Each CodeMod
 * describes ONE change to ONE file. It includes everything needed to:
 * 1. Understand what the change is (description, rationale)
 * 2. Apply the change (target_file, diff)
 * 3. Evaluate the change (expected_impact)
 *
 * CodeMods are FROZEN (immutable) — once proposed, they can never be altered.
 * This ensures the evolution history is a faithful record of what was tried.
 *
 * Attributes:
 *   target_file: Which file to modify (relative path).
 *   description: What the change does (human-readable).
 *   diff: The unified diff showing the exact change.
 *   rationale: Why this change should help (evidence-based reasoning).
 *   expected_impact: What metric should improve and by how much.
 */
export class CodeMod {
  readonly target_file: string;
  readonly description: string;
  readonly diff: string;
  readonly rationale: string;
  readonly expected_impact: string;

  constructor(options: Partial<CodeMod> = {}) {
    this.target_file = options.target_file ?? '';
    this.description = options.description ?? '';
    this.diff = options.diff ?? '';
    this.rationale = options.rationale ?? '';
    this.expected_impact = options.expected_impact ?? '';
  }

  /**
   * Serialize this CodeMod to a plain dictionary.
   *
   * Useful for JSON serialization — stores in evolution history logs,
   * sends to the promotion gate, etc.
   *
   * Returns:
   *   A dictionary with all CodeMod fields.
   */
  to_dict(): Record<string, unknown> {
    return {
      target_file: this.target_file,
      description: this.description,
      diff: this.diff,
      rationale: this.rationale,
      expected_impact: this.expected_impact,
    };
  }

  /**
   * Create a CodeMod from a plain dictionary.
   *
   * This is the inverse of to_dict(). Missing fields default to empty strings.
   *
   * Args:
   *   d: A dictionary with CodeMod fields.
   *
   * Returns:
   *   A new CodeMod instance.
   */
  static from_dict(d: Record<string, unknown>): CodeMod {
    return new CodeMod({
      target_file: (d['target_file'] as string) ?? '',
      description: (d['description'] as string) ?? '',
      diff: (d['diff'] as string) ?? '',
      rationale: (d['rationale'] as string) ?? '',
      expected_impact: (d['expected_impact'] as string) ?? '',
    });
  }

  /**
   * Apply this modification's diff to a set of file contents.
   *
   * Plain English: Imagine you have a stack of recipe cards (files) and a
   * modification note (diff). This method takes the note, finds the right
   * recipe card, and makes the change. It returns the whole stack — the
   * modified card plus all the untouched ones.
   *
   * If the target file doesn't exist in the dict, the files are returned
   * unchanged (safety first — we never create files out of thin air).
   *
   * Args:
   *   files: Dict mapping file path to file content.
   *
   * Returns:
   *   A NEW dict with the modification applied. The original dict is
   *   not modified (copy-on-write semantics).
   */
  apply_to(files: Record<string, string>): Record<string, string> {
    if (!(this.target_file in files)) {
      return { ...files };
    }

    const hunks = parse_unified_diff(this.diff);
    if (hunks.length === 0) {
      return { ...files };
    }

    const result = { ...files };
    let content = result[this.target_file];

    // Apply each hunk: replace old text with new text
    for (const [old_text, new_text] of hunks) {
      if (old_text && content.includes(old_text)) {
        content = replaceFirst(content, old_text, new_text);
      }
    }

    result[this.target_file] = content;
    return result;
  }

  /**
   * Check if this modification passes basic safety checks.
   *
   * Plain English: Before we let the agent change its own code, we check
   * the modification for "red flags" — patterns that could be dangerous.
   * It's like a spell-checker, but for safety: we scan the diff text for
   * known-dangerous patterns like os.system("rm -rf /").
   *
   * This is NOT a complete security audit — it's a fast first-pass filter.
   * The promotion gate does additional validation.
   *
   * Returns:
   *   True if the modification looks safe, False if it contains
   *   dangerous patterns.
   */
  is_safe(): boolean {
    const text_to_check = `${this.diff} ${this.description} ${this.rationale}`;
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(text_to_check)) {
        return false;
      }
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// CodeModSet — a collection of related modifications
// ---------------------------------------------------------------------------

/**
 * A collection of related CodeMods applied as a unit.
 *
 * Plain English: Sometimes one improvement requires changes to multiple files.
 * For example, "add a new feature" might need changes in the processor,
 * the system prompt, AND the config. A CodeModSet bundles these related
 * changes together so they can be proposed, tested, and promoted as one.
 *
 * Think of it as a "pull request" — it contains multiple file changes that
 * together implement a single improvement.
 *
 * Attributes:
 *   mods: The list of CodeMods in this set.
 */
export class CodeModSet {
  readonly mods: readonly CodeMod[];

  constructor(options: { mods?: readonly CodeMod[] } = {}) {
    this.mods = options.mods ? [...options.mods] : [];
  }

  /**
   * Serialize this CodeModSet to a plain dictionary.
   *
   * Returns:
   *   A dict with a 'mods' key containing a list of serialized CodeMods.
   */
  to_dict(): Record<string, unknown> {
    return {
      mods: this.mods.map((m) => m.to_dict()),
    };
  }

  /**
   * Create a CodeModSet from a plain dictionary.
   *
   * Args:
   *   d: A dict with a 'mods' key containing a list of CodeMod dicts.
   *
   * Returns:
   *   A new CodeModSet instance.
   */
  static from_dict(d: Record<string, unknown>): CodeModSet {
    const mods = ((d['mods'] as Record<string, unknown>[]) ?? []).map((m) =>
      CodeMod.from_dict(m)
    );
    return new CodeModSet({ mods });
  }

  /**
   * Apply all modifications in order.
   *
   * Plain English: Like applying a stack of recipe changes one by one.
   * Each modification is applied to the result of the previous one,
   * so order matters! (Just like you'd add salt before sealing the jar.)
   *
   * Args:
   *   files: Dict mapping file path to file content.
   *
   * Returns:
   *   A NEW dict with all modifications applied.
   */
  apply_to(files: Record<string, string>): Record<string, string> {
    let result = { ...files };
    for (const mod of this.mods) {
      result = mod.apply_to(result);
    }
    return result;
  }

  /**
   * Check if ALL modifications in this set are safe.
   *
   * Plain English: One bad apple spoils the barrel. If ANY modification
   * in the set is unsafe, the whole set is rejected.
   *
   * Returns:
   *   True if every mod passes is_safe(), False otherwise.
   */
  is_safe(): boolean {
    return this.mods.every((m) => m.is_safe());
  }
}

// ---------------------------------------------------------------------------
// parse_unified_diff — extract (old, new) hunk pairs from unified diff text
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff into (old_text, new_text) hunk pairs.
 *
 * Plain English: A unified diff is a standard format for showing code changes.
 * Lines starting with '-' are the old code (being removed), lines starting
 * with '+' are the new code (being added), and lines starting with ' '
 * (space) are context lines (unchanged, just there for orientation).
 *
 * This function reads a unified diff and extracts what was there before
 * (old_text) and what should be there after (new_text) for each hunk.
 * Context lines appear in both old and new.
 *
 * Example:
 *     Input:
 *         --- a/hello.py
 *         +++ b/hello.py
 *         @@ -1,3 +1,3 @@
 *          unchanged
 *         -old_line
 *         +new_line
 *         still_here
 *
 *     Output: [("unchanged\nold_line\nstill_here\n",
 *              "unchanged\nnew_line\nstill_here\n")]
 *
 * Args:
 *   diff_text: The unified diff as a string.
 *
 * Returns:
 *   A list of (old_text, new_text) tuples, one per hunk.
 *   Returns empty list if the diff has no hunks.
 */
export function parse_unified_diff(diff_text: string): [string, string][] {
  if (!diff_text || !diff_text.trim()) {
    return [];
  }

  const lines = diff_text.split('\n');
  const hunks: [string, string][] = [];
  let old_lines: string[] = [];
  let new_lines: string[] = [];
  let in_hunk = false;

  for (const line of lines) {
    // Skip file headers (--- and +++ lines)
    if (line.startsWith('---') || line.startsWith('+++')) {
      continue;
    }

    // Hunk header (@@ ... @@) — start a new hunk
    if (line.startsWith('@@')) {
      // If we were already in a hunk, save it before starting a new one
      if (in_hunk && (old_lines.length > 0 || new_lines.length > 0)) {
        hunks.push([
          old_lines.length > 0 ? `${old_lines.join('\n')}\n` : '',
          new_lines.length > 0 ? `${new_lines.join('\n')}\n` : '',
        ]);
        old_lines = [];
        new_lines = [];
      }
      in_hunk = true;
      continue;
    }

    if (!in_hunk) {
      continue;
    }

    // Parse diff lines within the hunk.
    // In unified diff format:
    //   '-' prefix = removed line (old only)
    //   '+' prefix = added line (new only)
    //   ' ' prefix = context line (both old and new)
    // Bare empty lines (no prefix) are trailing-newline artifacts — skip them.
    if (line.startsWith('-')) {
      // Removed line — goes into old_text only
      old_lines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      // Added line — goes into new_text only
      new_lines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      // Context line — goes into both old and new (strip the leading space)
      old_lines.push(line.slice(1));
      new_lines.push(line.slice(1));
    }
    // else: bare empty line or unrecognized — skip it
  }

  // Don't forget the last hunk
  if (in_hunk && (old_lines.length > 0 || new_lines.length > 0)) {
    hunks.push([
      old_lines.length > 0 ? `${old_lines.join('\n')}\n` : '',
      new_lines.length > 0 ? `${new_lines.join('\n')}\n` : '',
    ]);
  }

  return hunks;
}
