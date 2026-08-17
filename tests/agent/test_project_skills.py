"""Tests for project-local skill discovery and the trust sidecar.

Covers legacy ``skills.trusted_project_dirs`` discovery (auto-migrated) plus the
EPIC #48970 trust store: the machine-written ``~/.hermes/project-trust.json``
sidecar, per-skill sha256 fingerprints (injection-swap gate), sticky deny, and
legacy-config migration.
"""

import os
from pathlib import Path

import pytest

import agent.skill_utils as su


@pytest.fixture
def project_env(tmp_path, monkeypatch):
    """A temp HERMES_HOME + a git-marked project with skills in both subdirs."""
    home = tmp_path / ".hermes"
    (home / "skills").mkdir(parents=True)
    config = home / "config.yaml"
    config.write_text("skills:\n  external_dirs: []\n")

    repo = tmp_path / "proj"
    (repo / ".git").mkdir(parents=True)
    hs = repo / ".hermes" / "skills" / "repo-skill"
    hs.mkdir(parents=True)
    (hs / "SKILL.md").write_text(
        "---\nname: repo-skill\ndescription: from repo\n---\nbody\n"
    )
    ag = repo / ".agents" / "skills" / "conv-skill"
    ag.mkdir(parents=True)
    (ag / "SKILL.md").write_text(
        "---\nname: conv-skill\ndescription: convention\n---\nbody\n"
    )

    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.chdir(repo)
    su._external_dirs_cache_clear()
    yield {"home": home, "repo": repo, "config": config}
    su._external_dirs_cache_clear()


def _trust(config: Path, repo: Path) -> None:
    config.write_text(
        f"skills:\n  external_dirs: []\n  trusted_project_dirs: ['{repo}']\n"
    )
    su._external_dirs_cache_clear()


class TestFindProjectRoot:
    def test_finds_git_dir_root(self, project_env):
        assert su.find_project_root() == project_env["repo"].resolve()

    def test_git_file_counts_as_marker(self, tmp_path, monkeypatch):
        # Worktrees/submodules have a .git FILE, not a dir
        repo = tmp_path / "wt"
        repo.mkdir()
        (repo / ".git").write_text("gitdir: /elsewhere\n")
        monkeypatch.chdir(repo)
        assert su.find_project_root() == repo.resolve()

    def test_no_git_returns_none(self, tmp_path, monkeypatch):
        d = tmp_path / "plain"
        d.mkdir()
        monkeypatch.chdir(d)
        assert su.find_project_root(start=d) is None

    def test_walks_up_from_subdir(self, project_env):
        sub = project_env["repo"] / "a" / "b"
        sub.mkdir(parents=True)
        os.chdir(sub)
        assert su.find_project_root() == project_env["repo"].resolve()


class TestTrustGate:
    def test_untrusted_loads_nothing(self, project_env):
        assert su.get_project_skills_dirs() == []

    def test_untrusted_notice_with_count(self, project_env):
        notice = su.get_untrusted_project_skills_root()
        assert notice is not None
        root, count = notice
        assert root == project_env["repo"].resolve()
        assert count == 2

    def test_trusted_returns_both_subdirs(self, project_env):
        _trust(project_env["config"], project_env["repo"])
        dirs = su.get_project_skills_dirs()
        assert (project_env["repo"] / ".hermes" / "skills").resolve() in dirs
        assert (project_env["repo"] / ".agents" / "skills").resolve() in dirs

    def test_trusted_no_notice(self, project_env):
        _trust(project_env["config"], project_env["repo"])
        assert su.get_untrusted_project_skills_root() is None

    def test_discovery_disabled_kills_both(self, project_env):
        project_env["config"].write_text(
            "skills:\n  project_discovery: false\n"
            f"  trusted_project_dirs: ['{project_env['repo']}']\n"
        )
        su._external_dirs_cache_clear()
        assert su.get_project_skills_dirs() == []
        assert su.get_untrusted_project_skills_root() is None

    def test_no_skills_no_notice(self, tmp_path, monkeypatch):
        home = tmp_path / ".hermes"
        (home / "skills").mkdir(parents=True)
        (home / "config.yaml").write_text("skills: {}\n")
        repo = tmp_path / "empty-proj"
        (repo / ".git").mkdir(parents=True)
        monkeypatch.setenv("HERMES_HOME", str(home))
        monkeypatch.chdir(repo)
        su._external_dirs_cache_clear()
        assert su.get_untrusted_project_skills_root() is None


class TestPrecedence:
    def test_scan_order_project_first(self, project_env):
        _trust(project_env["config"], project_env["repo"])
        order = su.get_scan_ordered_skills_dirs()
        proj_dirs = {
            (project_env["repo"] / ".hermes" / "skills").resolve(),
            (project_env["repo"] / ".agents" / "skills").resolve(),
        }
        assert set(order[:2]) == proj_dirs
        assert order[2] == su.get_skills_dir()

    def test_project_paths_are_readonly_owned(self, project_env):
        _trust(project_env["config"], project_env["repo"])
        p = project_env["repo"] / ".hermes" / "skills" / "repo-skill" / "SKILL.md"
        assert su.is_external_skill_path(p) is True

    def test_get_all_skills_dirs_unchanged(self, project_env):
        # Backward-compat contract: local first, no project tier here.
        _trust(project_env["config"], project_env["repo"])
        dirs = su.get_all_skills_dirs()
        assert dirs[0] == su.get_skills_dir()
        for d in dirs:
            assert ".agents" not in str(d)


# ── EPIC #48970: trust sidecar + per-skill fingerprints + sticky deny ──────
#
# These E2E-style cases exercise the real modules against a temp HERMES_HOME,
# writing/reading the machine sidecar ``project-trust.json`` directly. No mocks.

import json

import agent.project_trust as pt


def _hermes_trust(repo: Path) -> None:
    """Emulate ``hermes skills trust`` on *repo*: fingerprint + sidecar write."""
    dirs = su._candidate_project_skills_dirs(repo.resolve())
    pt.trust_project(repo.resolve(), pt.fingerprint_project_skills(dirs))


def _index_skill_names(monkeypatch) -> set:
    """Run the REAL skills index scan and return the loaded skill names.

    Clears the per-session cache first so each scenario reflects disk + sidecar.
    """
    import tools.skills_tool as st

    st._SKILLS_CACHE.clear()
    return {s["name"] for s in st._find_all_skills(skip_disabled=True)}


class TestSidecarTrust:
    def test_trust_writes_sidecar_not_config(self, project_env):
        _hermes_trust(project_env["repo"])
        sidecar = project_env["home"] / "project-trust.json"
        assert sidecar.exists()
        data = json.loads(sidecar.read_text())
        assert data["version"] == pt.SCHEMA_VERSION
        key = str(project_env["repo"].resolve())
        assert data["projects"][key]["status"] == "trusted"
        # Config.yaml must NOT have gained a trusted_project_dirs entry.
        cfg_text = project_env["config"].read_text()
        assert "trusted_project_dirs" not in cfg_text

    def test_trusted_sidecar_loads_dirs(self, project_env):
        assert su.get_project_skills_dirs() == []  # untrusted first
        _hermes_trust(project_env["repo"])
        dirs = su.get_project_skills_dirs()
        assert (project_env["repo"] / ".hermes" / "skills").resolve() in dirs
        assert (project_env["repo"] / ".agents" / "skills").resolve() in dirs

    def test_fingerprints_recorded_for_every_skill(self, project_env):
        _hermes_trust(project_env["repo"])
        fps = pt.approved_fingerprints(project_env["repo"].resolve())
        assert set(fps) == {"repo-skill", "conv-skill"}
        for digest in fps.values():
            assert len(digest) == 64  # sha256 hex

    def test_trusted_no_notice_when_unchanged(self, project_env):
        _hermes_trust(project_env["repo"])
        assert su.get_untrusted_project_skills_root() is None
        assert su.get_project_skill_change_notice() is None

    def test_index_loads_trusted_project_skills(self, project_env, monkeypatch):
        _hermes_trust(project_env["repo"])
        names = _index_skill_names(monkeypatch)
        assert "repo-skill" in names
        assert "conv-skill" in names


class TestHashGate:
    def test_changed_skill_excluded_and_notice(self, project_env, monkeypatch):
        _hermes_trust(project_env["repo"])
        # Edit the approved skill's content after approval.
        smd = project_env["repo"] / ".hermes" / "skills" / "repo-skill" / "SKILL.md"
        smd.write_text(
            "---\nname: repo-skill\ndescription: from repo\n---\nMALICIOUSLY SWAPPED\n"
        )
        # Excluded from the index; unchanged sibling still loads.
        names = _index_skill_names(monkeypatch)
        assert "repo-skill" not in names
        assert "conv-skill" in names
        # One-line re-approval notice surfaces exactly one changed skill.
        notice = su.get_project_skill_change_notice()
        assert notice is not None
        _, count = notice
        assert count == 1

    def test_new_skill_excluded_until_reapproval(self, project_env, monkeypatch):
        _hermes_trust(project_env["repo"])
        newd = project_env["repo"] / ".hermes" / "skills" / "added-later"
        newd.mkdir()
        (newd / "SKILL.md").write_text(
            "---\nname: added-later\ndescription: sneaked in\n---\nbody\n"
        )
        names = _index_skill_names(monkeypatch)
        assert "added-later" not in names  # new since approval → gated
        assert "repo-skill" in names        # untouched → still loads
        notice = su.get_project_skill_change_notice()
        assert notice is not None and notice[1] == 1

    def test_reapproval_clears_gate(self, project_env, monkeypatch):
        _hermes_trust(project_env["repo"])
        smd = project_env["repo"] / ".hermes" / "skills" / "repo-skill" / "SKILL.md"
        smd.write_text("---\nname: repo-skill\ndescription: from repo\n---\nedited\n")
        assert "repo-skill" not in _index_skill_names(monkeypatch)
        # Re-run trust: re-fingerprints everything → gate clears.
        _hermes_trust(project_env["repo"])
        assert su.get_project_skill_change_notice() is None
        assert "repo-skill" in _index_skill_names(monkeypatch)

    def test_line_ending_change_is_not_a_content_change(self, project_env):
        _hermes_trust(project_env["repo"])
        smd = project_env["repo"] / ".hermes" / "skills" / "repo-skill" / "SKILL.md"
        original = smd.read_text()
        smd.write_text(original.replace("\n", "\r\n"))
        # CRLF churn must not read as a swap.
        assert su.get_project_skill_change_notice() is None


class TestRemovedSkillPrune:
    def test_removed_skill_pruned_on_next_trust(self, project_env):
        _hermes_trust(project_env["repo"])
        assert "conv-skill" in pt.approved_fingerprints(project_env["repo"].resolve())
        # Delete the .agents skill entirely, then re-trust.
        import shutil

        shutil.rmtree(project_env["repo"] / ".agents" / "skills" / "conv-skill")
        _hermes_trust(project_env["repo"])
        fps = pt.approved_fingerprints(project_env["repo"].resolve())
        assert "conv-skill" not in fps  # silently pruned
        assert "repo-skill" in fps

    def test_removed_skill_alone_is_not_a_change_notice(self, project_env):
        _hermes_trust(project_env["repo"])
        import shutil

        shutil.rmtree(project_env["repo"] / ".agents" / "skills" / "conv-skill")
        # A removal is not a change/add — no re-approval nag.
        assert su.get_project_skill_change_notice() is None


class TestStickyDeny:
    def test_deny_silences_all_notices(self, project_env):
        pt.deny_project(project_env["repo"].resolve())
        assert su.get_project_skills_dirs() == []
        assert su.get_untrusted_project_skills_root() is None
        assert su.get_project_skill_change_notice() is None
        assert pt.is_denied(project_env["repo"].resolve()) is True

    def test_deny_persisted_status(self, project_env):
        pt.deny_project(project_env["repo"].resolve())
        data = json.loads((project_env["home"] / "project-trust.json").read_text())
        key = str(project_env["repo"].resolve())
        assert data["projects"][key]["status"] == "denied"

    def test_forget_restores_notice(self, project_env):
        pt.deny_project(project_env["repo"].resolve())
        assert su.get_untrusted_project_skills_root() is None
        pt.forget_project(project_env["repo"].resolve())
        # Back to notice-eligible.
        notice = su.get_untrusted_project_skills_root()
        assert notice is not None and notice[1] == 2


class TestLegacyMigration:
    def test_legacy_config_entry_auto_migrates(self, project_env):
        # Legacy config-list trust with NO sidecar yet.
        _trust(project_env["config"], project_env["repo"])
        assert pt.get_project_entry(project_env["repo"].resolve()) is None
        # First resolution migrates it into the sidecar (fingerprinted).
        assert su.is_project_root_trusted(project_env["repo"].resolve()) is True
        entry = pt.get_project_entry(project_env["repo"].resolve())
        assert entry is not None
        assert entry["status"] == "trusted"
        assert set(entry["fingerprints"]) == {"repo-skill", "conv-skill"}

    def test_migrated_project_is_hash_gated(self, project_env, monkeypatch):
        _trust(project_env["config"], project_env["repo"])
        su.is_project_root_trusted(project_env["repo"].resolve())  # trigger migrate
        # A post-migration content swap is now gated, proving the hash gate
        # applies to migrated (formerly fingerprint-free) trust.
        smd = project_env["repo"] / ".hermes" / "skills" / "repo-skill" / "SKILL.md"
        smd.write_text("---\nname: repo-skill\ndescription: x\n---\nswapped\n")
        assert "repo-skill" not in _index_skill_names(monkeypatch)

    def test_deny_wins_over_legacy_config(self, project_env):
        # A sidecar deny must not be overridden by a stale legacy config entry.
        _trust(project_env["config"], project_env["repo"])
        pt.deny_project(project_env["repo"].resolve())
        assert su.is_project_root_trusted(project_env["repo"].resolve()) is False
        assert su.get_project_skills_dirs() == []


class TestAtomicSidecarWrite:
    def test_write_is_atomic_and_roundtrips(self, project_env):
        _hermes_trust(project_env["repo"])
        p = project_env["home"] / "project-trust.json"
        # No stray temp files left behind after an atomic replace.
        leftovers = [
            f for f in os.listdir(project_env["home"])
            if f.startswith("project-trust.json.") and f.endswith(".tmp")
        ]
        assert leftovers == []
        # Round-trips through load_sidecar.
        loaded = pt.load_sidecar()
        assert str(project_env["repo"].resolve()) in loaded["projects"]

    def test_corrupt_sidecar_fails_closed(self, project_env):
        (project_env["home"] / "project-trust.json").write_text("{ not json")
        # Malformed sidecar → empty skeleton, nothing trusted.
        assert pt.load_sidecar()["projects"] == {}
        assert su.is_project_root_trusted(project_env["repo"].resolve()) is False
