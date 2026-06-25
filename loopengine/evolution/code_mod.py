"""CodeMod represents a PROPOSED SELF-MODIFICATION — a change the agent wants to make to itself.

Plain English: Imagine you're a chef trying to improve your recipe. A CodeMod is
like a recipe modification note:
- target_file: Which recipe card to change (e.g., "loopengine/processors/context/system_prompt.py")
- description: What the change is (e.g., "Add step counting to the system prompt")
- diff: The exact text change (like showing the old and new recipe)
- rationale: Why you think this will help (e.g., "The agent keeps repeating itself")
- expected_impact: What metric should improve (e.g., "Efficiency should go up 10%")

The evolution layer generates CodeMods, tests them in a sandbox, and only applies
them if they actually improve performance.

Key safety principle: Every CodeMod has an is_safe() method that checks for
dangerous patterns like os.system, rm -rf, or dynamic imports. Unsafe mods
are rejected before they ever touch the real codebase.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


# ---------------------------------------------------------------------------
# Dangerous patterns — things we NEVER allow in a self-modification
# ---------------------------------------------------------------------------

# Plain English: These are the "red flags" that make a modification unsafe.
# Like a recipe change that says "add bleach" — we reject it immediately,
# no matter how good the rest of the change looks.
_DANGEROUS_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"os\.system\s*\("),
    re.compile(r"os\.popen\s*\("),
    re.compile(r"os\.exec[lv]\w*\s*\("),
    re.compile(r"os\.(remove|unlink|rmdir)\s*\("),
    re.compile(r"rm\s+-rf\b"),
    re.compile(r"shutil\.rmtree\s*\("),
    re.compile(r"\.rmtree\s*\("),
    re.compile(r"\.unlink\s*\("),
    re.compile(r"__import__\s*\(\s*['\"]os['\"]"),
    re.compile(r"__import__\s*\(\s*['\"]subprocess['\"]"),
    re.compile(r"importlib\.import_module\s*\("),
    re.compile(r"subprocess\.(call|run|Popen|check_output|check_call)\s*\("),
    re.compile(r"\bexec\s*\("),
    re.compile(r"\beval\s*\("),
]


# ---------------------------------------------------------------------------
# CodeMod — a single proposed change
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CodeMod:
    """A single proposed self-modification — one "recipe change note".

    Plain English: This is the atomic unit of self-improvement. Each CodeMod
    describes ONE change to ONE file. It includes everything needed to:
    1. Understand what the change is (description, rationale)
    2. Apply the change (target_file, diff)
    3. Evaluate the change (expected_impact)

    CodeMods are FROZEN (immutable) — once proposed, they can never be altered.
    This ensures the evolution history is a faithful record of what was tried.

    Attributes:
        target_file: Which file to modify (relative path).
        description: What the change does (human-readable).
        diff: The unified diff showing the exact change.
        rationale: Why this change should help (evidence-based reasoning).
        expected_impact: What metric should improve and by how much.
    """

    target_file: str = ""
    description: str = ""
    diff: str = ""
    rationale: str = ""
    expected_impact: str = ""

    def to_dict(self) -> dict[str, Any]:
        """Serialize this CodeMod to a plain dictionary.

        Useful for JSON serialization — stores in evolution history logs,
        sends to the promotion gate, etc.

        Returns:
            A dictionary with all CodeMod fields.
        """
        return {
            "target_file": self.target_file,
            "description": self.description,
            "diff": self.diff,
            "rationale": self.rationale,
            "expected_impact": self.expected_impact,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> CodeMod:
        """Create a CodeMod from a plain dictionary.

        This is the inverse of to_dict(). Missing fields default to empty strings.

        Args:
            d: A dictionary with CodeMod fields.

        Returns:
            A new CodeMod instance.
        """
        return cls(
            target_file=d.get("target_file", ""),
            description=d.get("description", ""),
            diff=d.get("diff", ""),
            rationale=d.get("rationale", ""),
            expected_impact=d.get("expected_impact", ""),
        )

    def apply_to(self, files: dict[str, str]) -> dict[str, str]:
        """Apply this modification's diff to a set of file contents.

        Plain English: Imagine you have a stack of recipe cards (files) and a
        modification note (diff). This method takes the note, finds the right
        recipe card, and makes the change. It returns the whole stack — the
        modified card plus all the untouched ones.

        If the target file doesn't exist in the dict, the files are returned
        unchanged (safety first — we never create files out of thin air).

        Args:
            files: Dict mapping file path to file content.

        Returns:
            A NEW dict with the modification applied. The original dict is
            not modified (copy-on-write semantics).
        """
        if self.target_file not in files:
            return dict(files)

        hunks = parse_unified_diff(self.diff)
        if not hunks:
            return dict(files)

        result = dict(files)
        content = result[self.target_file]

        # Apply each hunk: replace old text with new text
        for old_text, new_text in hunks:
            if old_text and old_text in content:
                content = content.replace(old_text, new_text, 1)

        result[self.target_file] = content
        return result

    def apply_with_status(
        self, files: dict[str, str]
    ) -> tuple[dict[str, str], bool]:
        """Apply this mod and report whether it actually landed.

        Unlike apply_to (which silently returns the files unchanged when the
        diff's anchor text isn't present), this returns a ``(files, applied)``
        pair. ``applied`` is True only when the target exists, the diff parses
        to at least one hunk, and every hunk's removed/context anchor was found
        and replaced. The evolution loop uses this to skip no-op mods instead of
        wasting a benchmark run on them (bug M1).

        Args:
            files: Dict mapping file path to content.

        Returns:
            A ``(new_files, applied)`` tuple. ``new_files`` is a fresh dict.
        """
        if self.target_file not in files:
            return dict(files), False

        hunks = parse_unified_diff(self.diff)
        if not hunks:
            return dict(files), False

        result = dict(files)
        content = result[self.target_file]
        applied_any = False
        all_anchors_found = True

        for old_text, new_text in hunks:
            if old_text:
                if old_text in content:
                    content = content.replace(old_text, new_text, 1)
                    applied_any = True
                else:
                    all_anchors_found = False
            else:
                # Pure addition with no anchor — cannot place it reliably.
                all_anchors_found = False

        result[self.target_file] = content
        return result, (applied_any and all_anchors_found)

    def _added_lines(self) -> str:
        """Return only the lines INTRODUCED by this diff (the '+' lines).

        Context and removed lines are existing code, not something this mod
        introduces, so they must not trigger the safety check. File headers
        ('+++') are excluded.
        """
        added: list[str] = []
        for line in self.diff.split("\n"):
            if line.startswith("+++"):
                continue
            if line.startswith("+"):
                added.append(line[1:])
        return "\n".join(added)

    def is_safe(self) -> bool:
        """Check if this modification passes basic safety checks.

        Plain English: Before we let the agent change its own code, we check
        the modification for "red flags" — patterns that could be dangerous.
        It's like a spell-checker, but for safety: we scan the diff text for
        known-dangerous patterns like os.system("rm -rf /").

        This is NOT a complete security audit — it's a fast first-pass filter.
        The promotion gate does additional validation.

        Only the ADDED code lines are scanned. Scanning the description/rationale
        prose produced false positives (a mod that merely *mentions* a dangerous
        call in its reasoning was wrongly rejected), and scanning removed/context
        lines flags pre-existing code this mod did not introduce (bug H1).

        Returns:
            True if the modification looks safe, False if it contains
            dangerous patterns.
        """
        text_to_check = self._added_lines()
        for pattern in _DANGEROUS_PATTERNS:
            if pattern.search(text_to_check):
                return False
        return True


# ---------------------------------------------------------------------------
# CodeModSet — a collection of related modifications
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CodeModSet:
    """A collection of related CodeMods applied as a unit.

    Plain English: Sometimes one improvement requires changes to multiple files.
    For example, "add a new feature" might need changes in the processor,
    the system prompt, AND the config. A CodeModSet bundles these related
    changes together so they can be proposed, tested, and promoted as one.

    Think of it as a "pull request" — it contains multiple file changes that
    together implement a single improvement.

    Attributes:
        mods: The list of CodeMods in this set.
    """

    mods: tuple[CodeMod, ...] = ()

    def __post_init__(self) -> None:
        """Convert a list to tuple for immutability."""
        if isinstance(self.mods, list):
            object.__setattr__(self, "mods", tuple(self.mods))

    def to_dict(self) -> dict[str, Any]:
        """Serialize this CodeModSet to a plain dictionary.

        Returns:
            A dict with a 'mods' key containing a list of serialized CodeMods.
        """
        return {
            "mods": [m.to_dict() for m in self.mods],
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> CodeModSet:
        """Create a CodeModSet from a plain dictionary.

        Args:
            d: A dict with a 'mods' key containing a list of CodeMod dicts.

        Returns:
            A new CodeModSet instance.
        """
        mods = [CodeMod.from_dict(m) for m in d.get("mods", [])]
        return cls(mods=mods)

    def apply_to(self, files: dict[str, str]) -> dict[str, str]:
        """Apply all modifications in order.

        Plain English: Like applying a stack of recipe changes one by one.
        Each modification is applied to the result of the previous one,
        so order matters! (Just like you'd add salt before sealing the jar.)

        Args:
            files: Dict mapping file path to file content.

        Returns:
            A NEW dict with all modifications applied.
        """
        result = dict(files)
        for mod in self.mods:
            result = mod.apply_to(result)
        return result

    def is_safe(self) -> bool:
        """Check if ALL modifications in this set are safe.

        Plain English: One bad apple spoils the barrel. If ANY modification
        in the set is unsafe, the whole set is rejected.

        Returns:
            True if every mod passes is_safe(), False otherwise.
        """
        return all(m.is_safe() for m in self.mods)


# ---------------------------------------------------------------------------
# parse_unified_diff — extract (old, new) hunk pairs from unified diff text
# ---------------------------------------------------------------------------


def parse_unified_diff(diff_text: str) -> list[tuple[str, str]]:
    """Parse a unified diff into (old_text, new_text) hunk pairs.

    Plain English: A unified diff is a standard format for showing code changes.
    Lines starting with '-' are the old code (being removed), lines starting
    with '+' are the new code (being added), and lines starting with ' '
    (space) are context lines (unchanged, just there for orientation).

    This function reads a unified diff and extracts what was there before
    (old_text) and what should be there after (new_text) for each hunk.
    Context lines appear in both old and new.

    Example:
        Input:
            --- a/hello.py
            +++ b/hello.py
            @@ -1,3 +1,3 @@
             unchanged
            -old_line
            +new_line
            still_here

        Output: [("unchanged\\nold_line\\nstill_here\\n",
                  "unchanged\\nnew_line\\nstill_here\\n")]

    Args:
        diff_text: The unified diff as a string.

    Returns:
        A list of (old_text, new_text) tuples, one per hunk.
        Returns empty list if the diff has no hunks.
    """
    if not diff_text or not diff_text.strip():
        return []

    lines = diff_text.split("\n")
    hunks: list[tuple[str, str]] = []
    old_lines: list[str] = []
    new_lines: list[str] = []
    in_hunk = False

    for line in lines:
        # Skip file headers (--- and +++ lines)
        if line.startswith("---") or line.startswith("+++"):
            continue

        # Hunk header (@@ ... @@) — start a new hunk
        if line.startswith("@@"):
            # If we were already in a hunk, save it before starting a new one
            if in_hunk and (old_lines or new_lines):
                hunks.append(("\n".join(old_lines) + "\n" if old_lines else "",
                              "\n".join(new_lines) + "\n" if new_lines else ""))
                old_lines = []
                new_lines = []
            in_hunk = True
            continue

        if not in_hunk:
            continue

        # Parse diff lines within the hunk.
        # In unified diff format:
        #   '-' prefix = removed line (old only)
        #   '+' prefix = added line (new only)
        #   ' ' prefix = context line (both old and new)
        # Bare empty lines (no prefix) are trailing-newline artifacts — skip them.
        if line.startswith("-"):
            # Removed line — goes into old_text only
            old_lines.append(line[1:])
        elif line.startswith("+"):
            # Added line — goes into new_text only
            new_lines.append(line[1:])
        elif line.startswith(" "):
            # Context line — goes into both old and new (strip the leading space)
            old_lines.append(line[1:])
            new_lines.append(line[1:])
        # else: bare empty line or unrecognized — skip it

    # Don't forget the last hunk
    if in_hunk and (old_lines or new_lines):
        hunks.append(("\n".join(old_lines) + "\n" if old_lines else "",
                      "\n".join(new_lines) + "\n" if new_lines else ""))

    return hunks
