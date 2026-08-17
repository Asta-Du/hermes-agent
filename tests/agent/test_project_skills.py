"""Tests for project-local skill discovery (skills.trusted_project_dirs)."""

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


# ── Canonical project identity across git worktrees (EPIC #48970) ──────────
#
# These build a REAL git repo + `git worktree add` so we exercise the actual
# `git rev-parse --git-common-dir` path rather than mocking it.

import shutil
import subprocess


def _run_git(*args, cwd) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=True,
        env={
            **os.environ,
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@e",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@e",
        },
    ).stdout.strip()


git_binary = pytest.mark.skipif(
    shutil.which("git") is None, reason="git binary not available"
)


@pytest.fixture
def real_repo_with_worktree(tmp_path, monkeypatch):
    """A real git repo (``main``) plus a linked worktree (``wt``).

    Layout::

        tmp_path/main   # primary checkout (.git dir)
        tmp_path/wt     # `git worktree add` checkout (.git FILE)

    A temp HERMES_HOME is wired up too, and the lru_cache on canonical
    identity is cleared around the test so a fresh tmp path can't collide
    with a cached identity.
    """
    home = tmp_path / ".hermes"
    (home / "skills").mkdir(parents=True)
    config = home / "config.yaml"
    config.write_text("skills:\n  external_dirs: []\n")

    main = tmp_path / "main"
    main.mkdir()
    _run_git("init", "-q", "-b", "main", cwd=main)
    (main / "README.md").write_text("hi\n")
    _run_git("add", "-A", cwd=main)
    _run_git("commit", "-q", "-m", "init", cwd=main)

    # A worktree of the SAME repo, checked out to a new branch.
    wt = tmp_path / "wt"
    _run_git("worktree", "add", "-q", "-b", "feature", str(wt), cwd=main)

    monkeypatch.setenv("HERMES_HOME", str(home))
    su._canonical_project_identity_str.cache_clear()
    su._external_dirs_cache_clear()
    yield {"home": home, "config": config, "main": main, "wt": wt}
    su._canonical_project_identity_str.cache_clear()
    su._external_dirs_cache_clear()


def _trust_path(config: Path, path: Path) -> None:
    config.write_text(
        f"skills:\n  external_dirs: []\n  trusted_project_dirs: ['{path}']\n"
    )
    su._external_dirs_cache_clear()


@git_binary
class TestCanonicalIdentityAcrossWorktrees:
    def test_main_and_worktree_share_identity(self, real_repo_with_worktree):
        main = real_repo_with_worktree["main"]
        wt = real_repo_with_worktree["wt"]
        # Both worktrees canonicalize to the SAME principal (the main root).
        assert su.canonical_project_identity(main) == su.canonical_project_identity(wt)
        # And that principal is the main checkout root.
        assert su.canonical_project_identity(wt) == main.resolve()

    def test_trust_main_covers_worktree(self, real_repo_with_worktree):
        cfg = real_repo_with_worktree["config"]
        main = real_repo_with_worktree["main"]
        wt = real_repo_with_worktree["wt"]
        _trust_path(cfg, main)
        assert su.is_project_root_trusted(main) is True
        assert su.is_project_root_trusted(wt) is True

    def test_trust_worktree_covers_main(self, real_repo_with_worktree):
        cfg = real_repo_with_worktree["config"]
        main = real_repo_with_worktree["main"]
        wt = real_repo_with_worktree["wt"]
        # Trust stores the raw worktree path; is_project_root_trusted must
        # still recognise the main checkout because both canonicalize equal.
        _trust_path(cfg, wt)
        assert su.is_project_root_trusted(wt) is True
        assert su.is_project_root_trusted(main) is True

    def test_untrusted_repo_not_trusted(self, real_repo_with_worktree):
        main = real_repo_with_worktree["main"]
        wt = real_repo_with_worktree["wt"]
        assert su.is_project_root_trusted(main) is False
        assert su.is_project_root_trusted(wt) is False

    def test_project_skills_load_in_worktree_when_main_trusted(
        self, real_repo_with_worktree, monkeypatch
    ):
        """Skills load from the WORKTREE's own checkout when the repo is trusted.

        Identity is canonicalized for the TRUST gate only — the dirs returned
        must be the worktree's actual .hermes/skills, not the main root's.
        """
        cfg = real_repo_with_worktree["config"]
        main = real_repo_with_worktree["main"]
        wt = real_repo_with_worktree["wt"]
        wt_skill = wt / ".hermes" / "skills" / "wt-skill"
        wt_skill.mkdir(parents=True)
        (wt_skill / "SKILL.md").write_text(
            "---\nname: wt-skill\ndescription: worktree-local\n---\nbody\n"
        )
        _trust_path(cfg, main)  # trust via the MAIN root
        monkeypatch.chdir(wt)   # but run inside the WORKTREE
        su._external_dirs_cache_clear()
        dirs = su.get_project_skills_dirs()
        assert (wt / ".hermes" / "skills").resolve() in dirs
        # The main root's skills dir must NOT be substituted in.
        assert (main / ".hermes" / "skills").resolve() not in dirs


@git_binary
class TestCanonicalIdentityFallback:
    def test_non_git_dir_identity_is_resolved_root(self, tmp_path):
        plain = tmp_path / "plain"
        plain.mkdir()
        su._canonical_project_identity_str.cache_clear()
        assert su.canonical_project_identity(plain) == plain.resolve()

    def test_non_git_trust_still_works(self, tmp_path, monkeypatch):
        # A non-git trusted dir must behave exactly as before: identity is the
        # resolved path, so trusting it trusts exactly it.
        home = tmp_path / ".hermes"
        (home / "skills").mkdir(parents=True)
        config = home / "config.yaml"
        plain = tmp_path / "plain"
        plain.mkdir()
        config.write_text(
            f"skills:\n  external_dirs: []\n  trusted_project_dirs: ['{plain}']\n"
        )
        monkeypatch.setenv("HERMES_HOME", str(home))
        su._canonical_project_identity_str.cache_clear()
        su._external_dirs_cache_clear()
        assert su.is_project_root_trusted(plain) is True
        assert su.is_project_root_trusted(tmp_path / "other") is False

    def test_missing_git_binary_falls_back_without_crash(
        self, real_repo_with_worktree, monkeypatch
    ):
        """No git on PATH → fall back to resolved root, no exception."""
        main = real_repo_with_worktree["main"]
        # Empty PATH so the subprocess `git` lookup raises FileNotFoundError.
        monkeypatch.setenv("PATH", "")
        su._canonical_project_identity_str.cache_clear()
        ident = su.canonical_project_identity(main)
        assert ident == main.resolve()
        # And the trust check degrades gracefully to path equality.
        cfg = real_repo_with_worktree["config"]
        _trust_path(cfg, main)
        assert su.is_project_root_trusted(main) is True

    def test_submodule_keeps_own_identity(self, tmp_path, monkeypatch):
        """A submodule's identity must NOT collapse into the superproject.

        Its common dir lives under ``.git/modules/<name>``; the parent-of-
        common-dir heuristic would wrongly point at the superproject's .git,
        so we fall back to the submodule's own resolved root.
        """
        monkeypatch.setenv(
            "GIT_ALLOW_PROTOCOL", "file"
        )  # allow local file:// submodule add
        sup = tmp_path / "super"
        sup.mkdir()
        _run_git("init", "-q", "-b", "main", cwd=sup)
        (sup / "a.txt").write_text("a\n")
        _run_git("add", "-A", cwd=sup)
        _run_git("commit", "-q", "-m", "init", cwd=sup)

        sub_origin = tmp_path / "sub-origin"
        sub_origin.mkdir()
        _run_git("init", "-q", "-b", "main", cwd=sub_origin)
        (sub_origin / "b.txt").write_text("b\n")
        _run_git("add", "-A", cwd=sub_origin)
        _run_git("commit", "-q", "-m", "init", cwd=sub_origin)

        _run_git(
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            str(sub_origin),
            "sub",
            cwd=sup,
        )
        sub = sup / "sub"
        su._canonical_project_identity_str.cache_clear()
        ident = su.canonical_project_identity(sub)
        # Submodule keeps its own resolved root, NOT the superproject root.
        assert ident == sub.resolve()
        assert ident != su.canonical_project_identity(sup)
