import json
import os
import shutil
import stat
from pathlib import Path

import pytest

from conftest import ROOT, make_cfg
from vie import analyse_cli
from vie.agents import choose_auto, detect_agents
from vie.config import load_config
from vie.prep import prep_video
from vie.sessions import Session
from vie.validate import short_status, validate_session, validate_video

FAKE = """#!/usr/bin/env bash
case "$1" in
  --version) echo "{name} 9.9.9"; exit 0;;
  auth) echo '{{"loggedIn": {logged}}}'; exit 0;;
  login) exit {login_rc};;
esac
python3 - "$@" <<'PY'
import json, os, sys
os.makedirs("analysis", exist_ok=True)
json.dump({{"argv": sys.argv[1:], "cwd": os.getcwd()}}, open("analysis/fake_{name}_invocation.json", "w"))
PY
"""


def install_fakes(tmp_path, monkeypatch, claude=True, codex=True, claude_logged=True):
    b = tmp_path / "fakebin"; shutil.rmtree(b, ignore_errors=True); b.mkdir()
    for name, on in (("claude", claude), ("codex", codex)):
        if on:
            p = b / name
            p.write_text(FAKE.format(name=name, logged=str(claude_logged).lower(), login_rc=0))
            p.chmod(p.stat().st_mode | stat.S_IEXEC)
    # keep real ffmpeg etc. but hide any real claude/codex
    keep = tmp_path / "realbin"; keep.mkdir(exist_ok=True)
    for t in ("ffmpeg", "ffprobe", "python3", "bash", "env", "cat", "mkdir", "ls"):
        w = shutil.which(t)
        if w and not (keep / t).exists(): (keep / t).symlink_to(w)
    monkeypatch.setenv("PATH", f"{b}:{keep}")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


def make_session(cfg, fixture_video, n=2):
    s = Session.create(cfg.sessions_dir)
    for i in range(n):
        shutil.copy(fixture_video, s.partial_dir / "x.mp4") if s.partial_dir.exists() else (s.partial_dir.mkdir(), shutil.copy(fixture_video, s.partial_dir / "x.mp4"))
        dest = s.ingest(s.partial_dir / "x.mp4")
        e = s.add({"id": f"CODE{i}", "url": f"https://example.test/reel/CODE{i}/", "creator": "c"})
        s.update(e, status="downloaded", file=f"videos/{dest.name}")
    s.finish("completed", "test")
    return s


def test_auto_selection(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)
    install_fakes(tmp_path, monkeypatch, claude=False, codex=True)
    ag = detect_agents(cfg)
    assert not ag["claude"].installed and ag["codex"].usable
    pick, why = choose_auto(ag, cfg)
    assert pick.key == "codex" and "installed and logged in" in why
    install_fakes(tmp_path, monkeypatch, claude=True, codex=True)
    ag = detect_agents(cfg)
    assert choose_auto(ag, cfg)[0].key == "claude"  # configured order
    ag["claude"].vision_probe = {"passed": False}
    assert choose_auto(ag, cfg)[0].key == "codex"   # a failed real probe demotes it
    install_fakes(tmp_path, monkeypatch, claude=True, codex=False, claude_logged=False)
    with pytest.raises(RuntimeError, match="no usable analysis agent"):
        choose_auto(detect_agents(cfg), cfg)


def test_launcher_end_to_end_with_fake_agent(tmp_path, monkeypatch, fixture_video, capsys):
    cfg = make_cfg(tmp_path)
    install_fakes(tmp_path, monkeypatch)
    s = make_session(cfg, fixture_video, 2)
    cfgfile = tmp_path / "c.toml"
    cfgfile.write_text(f'[paths]\nsessions_dir="{cfg.sessions_dir}"\nstate_dir="{tmp_path}/state"\n')
    assert short_status(s.path) == "not analysed"
    rc = analyse_cli.main(["--config", str(cfgfile), "--session", "latest", "--agent", "claude", "-y"])
    assert rc == 0
    an = s.path / "analysis"
    inv = json.loads((an / "fake_claude_invocation.json").read_text())
    assert inv["cwd"] == str(s.path)
    prompt = inv["argv"][0]
    assert str(s.path) in prompt and "0001, 0002" in prompt and "Look, don't assume" in prompt
    assert "--allowedTools" in inv["argv"] and "--permission-mode" in inv["argv"]
    assert (an / "PROMPT.md").read_text() == prompt
    launch = json.loads((an / "launch.json").read_text())
    assert launch["agent"] == "claude" and launch["exit_code"] == 0
    # deterministic prep ran for every video before the agent started
    for v in ("0001", "0002"):
        assert (an / "prep" / v / "facts.json").is_file()
    out = capsys.readouterr().out
    assert s.id in out and "Analysis state: in progress" not in out  # nothing valid yet
    assert "not started" in out or "0/2" in out
    # originals untouched and still read-only
    assert all(not os.access(p, os.W_OK) for p in (s.path / "videos").glob("*.mp4"))


def test_codex_command_and_dry_run(tmp_path, monkeypatch, fixture_video, capsys):
    cfg = make_cfg(tmp_path)
    install_fakes(tmp_path, monkeypatch)
    s = make_session(cfg, fixture_video, 1)
    cfgfile = tmp_path / "c.toml"
    cfgfile.write_text(f'[paths]\nsessions_dir="{cfg.sessions_dir}"\nstate_dir="{tmp_path}/state"\n[analysis]\ncodex_model="gpt-x"\n')
    assert analyse_cli.main(["--config", str(cfgfile), "--session", s.id, "--agent", "auto", "--dry-run", "--no-prep"]) == 0
    out = capsys.readouterr().out
    assert "Agent   : Claude Code" in out  # auto order default
    assert analyse_cli.main(["--config", str(cfgfile), "--session", s.id, "--agent", "codex", "--dry-run", "--no-prep"]) == 0
    out = capsys.readouterr().out
    assert "-s workspace-write" in out and "-m gpt-x" in out and f"-C {s.path}" in out
    assert not (s.path / "analysis" / "fake_codex_invocation.json").exists()


def good_video_json(fx_dir, vid, facts):
    frames = [f["file"] for f in facts["frames"]]
    return {"schema_version": 1, "video": vid, "summary": "s",
            "evidence_reviewed": {"frames": frames[:6], "measured_facts": True, "audio": "measured-only"},
            "observations": [{"id": "o1", "category": "editing_rhythm", "text": "four flat colour shots", "t_start": 0, "t_end": 4,
                              "evidence_frames": frames[:2], "evidence_measured": ["rhythm.shot_count"], "confidence": "high"}],
            "inferences": [{"id": "i1", "kind": "intent", "text": "test card", "based_on": ["o1"], "confidence": "low"}],
            "uncertainties": ["software unknown"], "recreation": []}


def test_validator_rejects_pretend_analysis(tmp_path, fixture_video):
    prep = tmp_path / "prep"
    facts = prep_video(fixture_video, prep, load_config(root=tmp_path, env={})["prep"])
    vid = fixture_video.stem
    f = tmp_path / f"{vid}.json"
    ok = good_video_json(prep, vid, facts)
    f.write_text(json.dumps(ok)); assert validate_video(f, prep) == []
    def broken(mut):
        d = json.loads(json.dumps(ok)); mut(d); f.write_text(json.dumps(d)); return " | ".join(validate_video(f, prep))
    assert "do not exist" in broken(lambda d: d["evidence_reviewed"]["frames"].append("frames/ghost.jpg"))
    assert "at least" in broken(lambda d: d["evidence_reviewed"].update(frames=[]))
    assert "needs evidence" in broken(lambda d: d["observations"][0].update(evidence_frames=[], evidence_measured=[]))
    assert "within 0.." in broken(lambda d: d["observations"][0].update(t_end=99))
    assert "based_on" in broken(lambda d: d["inferences"][0].update(based_on=["o9"]))
    assert "bad category" in broken(lambda d: d["observations"][0].update(category="vibes"))
    assert "measured_facts" in broken(lambda d: d["evidence_reviewed"].update(measured_facts=False))


def test_session_status_lifecycle(tmp_path, fixture_video):
    cfg = make_cfg(tmp_path)
    s = make_session(cfg, fixture_video, 1)
    from vie.prep import prep_session
    prep_session(s.path, cfg["prep"])
    facts = json.loads((s.path / "analysis/prep/0001/facts.json").read_text())
    assert validate_session(s.path)["state"] == "not started"
    (s.path / "analysis/videos").mkdir()
    (s.path / "analysis/videos/0001.json").write_text(json.dumps(good_video_json(None, "0001", facts)))
    assert validate_session(s.path)["state"] == "in progress" and short_status(s.path).startswith("partial")
    an = s.path / "analysis"
    (an / "patterns.json").write_text(json.dumps({"patterns": [{"id": "p1", "supporting_videos": [{"video": "0001"}]}]}))
    (an / "report.md").write_text("# r")
    assert validate_session(s.path)["state"] == "complete" and short_status(s.path) == "analysed (1/1)"
    (an / "patterns.json").write_text(json.dumps({"patterns": [{"id": "p1", "supporting_videos": [{"video": "9999"}]}]}))
    assert validate_session(s.path)["state"] == "in progress"
