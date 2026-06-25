"""Tests for the CodeMod module — proposed self-modifications.

BDD Scenarios:
- Given a target file and diff, When I create a CodeMod, Then all fields are stored
- Given a CodeMod, When I try to mutate it, Then FrozenInstanceError is raised
- Given a CodeMod, When I call to_dict/from_dict, Then roundtrip preserves all data
- Given a CodeMod and file contents, When I call apply_to, Then the diff is applied
- Given a safe CodeMod, When I check is_safe, Then it returns True
- Given a dangerous CodeMod (os.system, rm -rf), When I check is_safe, Then it returns False
- Given a CodeModSet, When I apply multiple mods, Then all are applied in order
- Given a unified diff string, When I parse it, Then I get (old, new) hunks
"""

from __future__ import annotations

import pytest
from dataclasses import FrozenInstanceError

from loopengine.evolution.code_mod import (
    CodeMod,
    CodeModSet,
    parse_unified_diff,
)


# =========================================================================
# SLICE 1: CodeMod creation
# =========================================================================

class TestCodeModCreation:
    """Given a target file, description, diff, rationale, and expected impact,
    When I create a CodeMod,
    Then all fields are stored correctly and it is immutable."""

    def test_creation_with_defaults(self) -> None:
        """A CodeMod with minimal fields should have sensible defaults."""
        mod = CodeMod()
        assert mod.target_file == ""
        assert mod.description == ""
        assert mod.diff == ""
        assert mod.rationale == ""
        assert mod.expected_impact == ""

    def test_creation_with_explicit_fields(self) -> None:
        """A CodeMod with explicit fields stores them correctly."""
        mod = CodeMod(
            target_file="loopengine/processors/context/system_prompt.py",
            description="Add step counting to the system prompt",
            diff="--- a/file.py\n+++ b/file.py\n@@ -1 +1 @@\n-old\n+new",
            rationale="The agent keeps repeating itself",
            expected_impact="Efficiency should go up 10%",
        )
        assert mod.target_file == "loopengine/processors/context/system_prompt.py"
        assert mod.description == "Add step counting to the system prompt"
        assert "old" in mod.diff
        assert "new" in mod.diff
        assert mod.rationale == "The agent keeps repeating itself"
        assert mod.expected_impact == "Efficiency should go up 10%"

    def test_is_frozen(self) -> None:
        """A CodeMod is immutable (frozen dataclass)."""
        mod = CodeMod(target_file="test.py")
        with pytest.raises(FrozenInstanceError):
            mod.target_file = "other.py"  # type: ignore[misc]

    def test_equality(self) -> None:
        """Two CodeMods with the same data are equal."""
        mod1 = CodeMod(target_file="a.py", diff="+new")
        mod2 = CodeMod(target_file="a.py", diff="+new")
        assert mod1 == mod2


# =========================================================================
# SLICE 2: CodeMod serialization roundtrip
# =========================================================================

class TestCodeModSerialization:
    """Given a CodeMod,
    When I call to_dict() and then from_dict(),
    Then the roundtrip preserves all data."""

    def test_to_dict(self) -> None:
        """to_dict produces a plain dictionary with all fields."""
        mod = CodeMod(
            target_file="a.py",
            description="test change",
            diff="-old\n+new",
            rationale="because",
            expected_impact="better",
        )
        d = mod.to_dict()
        assert d["target_file"] == "a.py"
        assert d["description"] == "test change"
        assert d["diff"] == "-old\n+new"
        assert d["rationale"] == "because"
        assert d["expected_impact"] == "better"

    def test_from_dict(self) -> None:
        """from_dict creates a CodeMod from a plain dictionary."""
        d = {
            "target_file": "a.py",
            "description": "test change",
            "diff": "-old\n+new",
            "rationale": "because",
            "expected_impact": "better",
        }
        mod = CodeMod.from_dict(d)
        assert mod.target_file == "a.py"
        assert mod.description == "test change"
        assert mod.diff == "-old\n+new"

    def test_roundtrip(self) -> None:
        """to_dict → from_dict roundtrip produces an equal CodeMod."""
        original = CodeMod(
            target_file="loopengine/foo.py",
            description="Add logging",
            diff="-x\n+y",
            rationale="debugging",
            expected_impact="visibility",
        )
        restored = CodeMod.from_dict(original.to_dict())
        assert restored == original

    def test_from_dict_missing_fields(self) -> None:
        """from_dict handles missing fields gracefully (defaults to empty)."""
        d = {"target_file": "a.py"}
        mod = CodeMod.from_dict(d)
        assert mod.target_file == "a.py"
        assert mod.description == ""
        assert mod.diff == ""


# =========================================================================
# SLICE 3: CodeMod.apply_to — basic diff application
# =========================================================================

class TestCodeModApplyTo:
    """Given a CodeMod with a simple diff and a dict of file contents,
    When I call apply_to(),
    Then the diff is applied and modified files are returned."""

    def test_apply_simple_replacement(self) -> None:
        """Given a single-file diff with one replacement, When I apply,
        Then the file is modified with the new content."""
        # Simple unified diff: replace "old_line" with "new_line"
        diff = (
            "--- a/hello.py\n"
            "+++ b/hello.py\n"
            "@@ -1 +1 @@\n"
            "-old_line\n"
            "+new_line\n"
        )
        mod = CodeMod(target_file="hello.py", diff=diff)
        files = {"hello.py": "old_line\n"}

        result = mod.apply_to(files)

        assert "hello.py" in result
        assert "new_line" in result["hello.py"]
        assert "old_line" not in result["hello.py"]

    def test_apply_preserves_unmodified_files(self) -> None:
        """Files not targeted by the diff are returned unchanged."""
        diff = (
            "--- a/a.py\n"
            "+++ b/a.py\n"
            "@@ -1 +1 @@\n"
            "-old\n"
            "+new\n"
        )
        mod = CodeMod(target_file="a.py", diff=diff)
        files = {"a.py": "old\n", "b.py": "untouched\n"}

        result = mod.apply_to(files)

        assert result["b.py"] == "untouched\n"

    def test_apply_to_missing_file(self) -> None:
        """If the target file doesn't exist in the dict, return files unchanged."""
        diff = (
            "--- a/missing.py\n"
            "+++ b/missing.py\n"
            "@@ -1 +1 @@\n"
            "-old\n"
            "+new\n"
        )
        mod = CodeMod(target_file="missing.py", diff=diff)
        files = {"other.py": "content\n"}

        result = mod.apply_to(files)
        # Should return files unchanged when target not found
        assert result["other.py"] == "content\n"


# =========================================================================
# SLICE 4: CodeMod.apply_to — multiple hunks
# =========================================================================

class TestCodeModApplyMultipleHunks:
    """Given a diff with multiple hunks,
    When I call apply_to(),
    Then all hunks are applied."""

    def test_apply_multiple_replacements(self) -> None:
        """Given a diff with two hunks in one file, When I apply,
        Then both replacements are applied."""
        diff = (
            "--- a/multi.py\n"
            "+++ b/multi.py\n"
            "@@ -1 +1 @@\n"
            "-first_old\n"
            "+first_new\n"
            "@@ -3 +3 @@\n"
            "-second_old\n"
            "+second_new\n"
        )
        mod = CodeMod(target_file="multi.py", diff=diff)
        files = {"multi.py": "first_old\nkeep\nsecond_old\n"}

        result = mod.apply_to(files)
        content = result["multi.py"]

        assert "first_new" in content
        assert "second_new" in content
        assert "first_old" not in content
        assert "second_old" not in content


# =========================================================================
# SLICE 5: CodeMod.is_safe — safety checks
# =========================================================================

class TestCodeModIsSafe:
    """Given various CodeMods,
    When I check is_safe(),
    Then safe mods return True and dangerous mods return False."""

    def test_safe_mod(self) -> None:
        """A normal code change is safe."""
        mod = CodeMod(
            target_file="a.py",
            description="Add logging",
            diff="-old\n+new",
            rationale="better debugging",
        )
        assert mod.is_safe() is True

    def test_dangerous_os_system(self) -> None:
        """A mod containing os.system is NOT safe."""
        mod = CodeMod(
            target_file="a.py",
            description="Run a command",
            diff="+os.system('rm -rf /')",
            rationale="test",
        )
        assert mod.is_safe() is False

    def test_dangerous_rm_rf(self) -> None:
        """A mod containing rm -rf is NOT safe."""
        mod = CodeMod(
            target_file="a.py",
            description="Cleanup",
            diff="+import subprocess\n+subprocess.run(['rm', '-rf', '/'])",
            rationale="cleanup",
        )
        assert mod.is_safe() is False

    def test_dangerous_import_os(self) -> None:
        """A mod containing __import__('os') is NOT safe."""
        mod = CodeMod(
            target_file="a.py",
            description="Dynamic import",
            diff="+__import__('os')",
            rationale="test",
        )
        assert mod.is_safe() is False

    def test_dangerous_subprocess(self) -> None:
        """A mod containing subprocess.call is NOT safe."""
        mod = CodeMod(
            target_file="a.py",
            description="Subprocess call",
            diff="+subprocess.call(['ls'])",
            rationale="test",
        )
        assert mod.is_safe() is False

    def test_dangerous_exec(self) -> None:
        """A mod containing exec() is NOT safe."""
        mod = CodeMod(
            target_file="a.py",
            description="Exec code",
            diff="+exec('import os')",
            rationale="test",
        )
        assert mod.is_safe() is False

    def test_dangerous_eval(self) -> None:
        """A mod containing eval() is NOT safe."""
        mod = CodeMod(
            target_file="a.py",
            description="Eval code",
            diff="+eval('1+1')",
            rationale="test",
        )
        assert mod.is_safe() is False


# =========================================================================
# SLICE 6: CodeModSet — collection of related modifications
# =========================================================================

class TestCodeModSetCreation:
    """Given a list of CodeMods,
    When I create a CodeModSet,
    Then all mods are stored and accessible."""

    def test_creation(self) -> None:
        """A CodeModSet stores its mods."""
        mod1 = CodeMod(target_file="a.py", diff="-old\n+new")
        mod2 = CodeMod(target_file="b.py", diff="-x\n+y")
        mod_set = CodeModSet(mods=[mod1, mod2])

        assert len(mod_set.mods) == 2
        assert mod_set.mods[0] is mod1
        assert mod_set.mods[1] is mod2

    def test_is_frozen(self) -> None:
        """A CodeModSet is immutable."""
        mod_set = CodeModSet(mods=[CodeMod(target_file="a.py")])
        with pytest.raises(FrozenInstanceError):
            mod_set.mods = []  # type: ignore[misc]


class TestCodeModSetApplyTo:
    """Given a CodeModSet with multiple mods,
    When I call apply_to(),
    Then all mods are applied in order."""

    def test_apply_multiple_mods(self) -> None:
        """Multiple mods targeting different files are all applied."""
        mod1 = CodeMod(
            target_file="a.py",
            diff="--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-old\n+new\n",
        )
        mod2 = CodeMod(
            target_file="b.py",
            diff="--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-foo\n+bar\n",
        )
        mod_set = CodeModSet(mods=[mod1, mod2])
        files = {"a.py": "old\n", "b.py": "foo\n"}

        result = mod_set.apply_to(files)

        assert "new" in result["a.py"]
        assert "bar" in result["b.py"]

    def test_apply_sequential_order(self) -> None:
        """Mods are applied in the order they appear in the list."""
        # Two mods targeting the same file — second builds on first
        mod1 = CodeMod(
            target_file="a.py",
            diff="--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-old\n+middle\n",
        )
        mod2 = CodeMod(
            target_file="a.py",
            diff="--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-middle\n+new\n",
        )
        mod_set = CodeModSet(mods=[mod1, mod2])
        files = {"a.py": "old\n"}

        result = mod_set.apply_to(files)

        assert "new" in result["a.py"]
        assert "old" not in result["a.py"]


class TestCodeModSetIsSafe:
    """Given a CodeModSet,
    When I check is_safe(),
    Then it returns True only if ALL mods are safe."""

    def test_all_safe(self) -> None:
        """All safe mods → is_safe returns True."""
        mod1 = CodeMod(target_file="a.py", diff="-old\n+new")
        mod2 = CodeMod(target_file="b.py", diff="-x\n+y")
        mod_set = CodeModSet(mods=[mod1, mod2])
        assert mod_set.is_safe() is True

    def test_one_dangerous(self) -> None:
        """One dangerous mod → is_safe returns False."""
        mod1 = CodeMod(target_file="a.py", diff="-old\n+new")
        mod2 = CodeMod(target_file="b.py", diff="+os.system('rm -rf /')")
        mod_set = CodeModSet(mods=[mod1, mod2])
        assert mod_set.is_safe() is False


class TestCodeModSetSerialization:
    """Given a CodeModSet,
    When I call to_dict() and from_dict(),
    Then roundtrip preserves all data."""

    def test_roundtrip(self) -> None:
        """to_dict → from_dict roundtrip produces an equal CodeModSet."""
        mod1 = CodeMod(target_file="a.py", description="change a", diff="-old\n+new")
        mod2 = CodeMod(target_file="b.py", description="change b", diff="-x\n+y")
        original = CodeModSet(mods=[mod1, mod2])

        restored = CodeModSet.from_dict(original.to_dict())

        assert len(restored.mods) == 2
        assert restored.mods[0].target_file == "a.py"
        assert restored.mods[1].target_file == "b.py"

    def test_to_dict_structure(self) -> None:
        """to_dict produces a dict with a 'mods' key containing serialized mods."""
        mod_set = CodeModSet(mods=[CodeMod(target_file="a.py")])
        d = mod_set.to_dict()
        assert "mods" in d
        assert isinstance(d["mods"], list)
        assert len(d["mods"]) == 1
        assert d["mods"][0]["target_file"] == "a.py"


# =========================================================================
# SLICE 7: parse_unified_diff
# =========================================================================

class TestParseUnifiedDiff:
    """Given a unified diff string,
    When I call parse_unified_diff(),
    Then I get a list of (old_text, new_text) hunk pairs."""

    def test_simple_diff(self) -> None:
        """A simple one-hunk diff parses into one (old, new) pair."""
        diff = (
            "--- a/hello.py\n"
            "+++ b/hello.py\n"
            "@@ -1 +1 @@\n"
            "-old_line\n"
            "+new_line\n"
        )
        hunks = parse_unified_diff(diff)
        assert len(hunks) == 1
        old, new = hunks[0]
        assert "old_line" in old
        assert "new_line" in new

    def test_multi_hunk_diff(self) -> None:
        """A diff with two hunks parses into two pairs."""
        diff = (
            "--- a/multi.py\n"
            "+++ b/multi.py\n"
            "@@ -1 +1 @@\n"
            "-first_old\n"
            "+first_new\n"
            "@@ -10 +10 @@\n"
            "-second_old\n"
            "+second_new\n"
        )
        hunks = parse_unified_diff(diff)
        assert len(hunks) == 2
        assert "first_old" in hunks[0][0]
        assert "first_new" in hunks[0][1]
        assert "second_old" in hunks[1][0]
        assert "second_new" in hunks[1][1]

    def test_multi_line_hunk(self) -> None:
        """A hunk with multiple removed/added lines parses correctly."""
        diff = (
            "--- a/big.py\n"
            "+++ b/big.py\n"
            "@@ -1,3 +1,3 @@\n"
            "-line1\n"
            "-line2\n"
            "+new_line1\n"
            "+new_line2\n"
        )
        hunks = parse_unified_diff(diff)
        assert len(hunks) == 1
        old, new = hunks[0]
        assert "line1" in old
        assert "line2" in old
        assert "new_line1" in new
        assert "new_line2" in new

    def test_context_lines_ignored(self) -> None:
        """Context lines (space prefix) are included in old and new equally."""
        diff = (
            "--- a/ctx.py\n"
            "+++ b/ctx.py\n"
            "@@ -1,3 +1,3 @@\n"
            " unchanged\n"
            "-old\n"
            "+new\n"
            " still_here\n"
        )
        hunks = parse_unified_diff(diff)
        assert len(hunks) == 1
        old, new = hunks[0]
        assert "unchanged" in old
        assert "unchanged" in new
        assert "still_here" in old
        assert "still_here" in new

    def test_empty_diff(self) -> None:
        """An empty diff returns an empty list."""
        hunks = parse_unified_diff("")
        assert hunks == []

    def test_no_hunks_diff(self) -> None:
        """A diff with only headers but no hunks returns an empty list."""
        diff = "--- a/empty.py\n+++ b/empty.py\n"
        hunks = parse_unified_diff(diff)
        assert hunks == []


# =========================================================================
# SLICE: is_safe hardening (bug H1)
# =========================================================================


class TestCodeModSafetyHardening:
    """is_safe scans only the ADDED code lines and covers more dangerous calls."""

    def test_rationale_mentioning_danger_is_not_a_false_positive(self) -> None:
        """Prose may discuss dangerous APIs; only the actual added code matters."""
        danger = "os." + "system"  # avoid the literal token in source
        mod = CodeMod(
            target_file="a.py",
            description="Refactor cleanup",
            diff="--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-old\n+x = 1\n",
            rationale=f"This removes the unsafe {danger}() call entirely.",
        )
        assert mod.is_safe() is True

    def test_recursive_tree_removal_is_unsafe(self) -> None:
        call = "shutil.rm" + "tree("
        mod = CodeMod(
            target_file="a.py",
            description="cleanup",
            diff=f"--- a/a.py\n+++ b/a.py\n@@ -1 +1,2 @@\n unchanged\n+    {call}path)\n",
            rationale="cleanup",
        )
        assert mod.is_safe() is False

    def test_os_popen_is_unsafe(self) -> None:
        call = "os.po" + "pen("
        mod = CodeMod(
            target_file="a.py",
            description="run",
            diff=f"--- a/a.py\n+++ b/a.py\n@@ -1 +1,2 @@\n unchanged\n+    {call}'ls')\n",
            rationale="x",
        )
        assert mod.is_safe() is False


# =========================================================================
# SLICE: apply detection (bug M1)
# =========================================================================


class TestCodeModApplyStatus:
    """apply_with_status signals whether the diff actually applied."""

    def test_applies_when_anchor_found(self) -> None:
        mod = CodeMod(
            target_file="a.py",
            diff="--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-old\n+new\n",
        )
        result, applied = mod.apply_with_status({"a.py": "old\n"})
        assert applied is True
        assert result["a.py"] == "new\n"

    def test_reports_not_applied_when_anchor_missing(self) -> None:
        mod = CodeMod(
            target_file="a.py",
            diff="--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-NOPE\n+new\n",
        )
        result, applied = mod.apply_with_status({"a.py": "completely different\n"})
        assert applied is False
        assert result["a.py"] == "completely different\n"

    def test_reports_not_applied_when_target_missing(self) -> None:
        mod = CodeMod(
            target_file="missing.py",
            diff="--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
        )
        result, applied = mod.apply_with_status({"a.py": "x\n"})
        assert applied is False
