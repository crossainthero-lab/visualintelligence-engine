import os
from datetime import datetime

import pytest

from vie.sessions import Session, known_videos, list_video_files, session_dirs


def test_create_never_reuses_folder(tmp_path):
    t = datetime(2026, 10, 19, 17, 30)
    a = Session.create(tmp_path, now=t)
    b = Session.create(tmp_path, now=t)
    assert a.id == "2026-10-19_1730" and b.id == "2026-10-19_1730_02"
    assert (a.path / "videos").is_dir() and (a.path / "analysis").is_dir()
    assert a.info["status"] == "running" and (a.path / "metadata.json").is_file()
    assert [p.name for p in session_dirs(tmp_path)] == [a.id, b.id]


def test_ingest_sequential_readonly_and_no_overwrite(tmp_path):
    s = Session.create(tmp_path)
    for i in range(3):
        f = s.partial_dir / f"t{i}.mp4"
        f.parent.mkdir(exist_ok=True)
        f.write_bytes(b"x" * (i + 1))
        dest = s.ingest(f)
        assert dest.name == f"000{i+1}.mp4"
        assert not f.exists() and not os.access(dest, os.W_OK)
    # a pre-existing 0004 (e.g. from a crash) is skipped, never overwritten
    (s.videos_dir / "0004.mp4").write_bytes(b"keep")
    f = s.partial_dir / "n.mp4"; f.write_bytes(b"new")
    assert s.ingest(f).name == "0005.mp4"
    assert (s.videos_dir / "0004.mp4").read_bytes() == b"keep"
    assert len(list_video_files(s.path)) == 5


def test_metadata_roundtrip_and_known(tmp_path):
    s = Session.create(tmp_path)
    e = s.add({"id": "ABC12345", "url": "u"})
    s.update(e, status="downloaded", file="videos/0001.mp4")
    s.add({"id": "ZZZ99999", "url": "u2"})
    s2 = Session(s.path)
    assert s2.counts() == {"downloaded": 1, "discovered": 1, "total": 2}
    assert list(known_videos(tmp_path)) == ["ABC12345"]
