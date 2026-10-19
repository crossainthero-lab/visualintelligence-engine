from pathlib import Path

from conftest import CUTS, make_video
from vie.config import DEFAULTS
from vie.prep import prep_video


def test_prep_measures_cuts_audio_and_frames(tmp_path, fixture_video):
    f = prep_video(fixture_video, tmp_path, DEFAULTS["prep"])
    assert abs(f["probe"]["duration_s"] - 4.0) < 0.1 and f["probe"]["width"] == 320
    got = [c["t"] for c in f["cuts"]]
    assert len(got) == 3 and all(abs(a - b) < 0.1 for a, b in zip(got, CUTS)), got
    assert f["rhythm"]["shot_count"] == 4 and abs(f["rhythm"]["average_shot_length_s"] - 1.0) < 0.15
    # every listed frame exists on disk and timestamps are within the video
    out = tmp_path / fixture_video.stem
    assert f["frames"] and all((out / fr["file"]).is_file() and 0 <= fr["t"] <= 4.0 for fr in f["frames"])
    assert any(fr["reason"].startswith("transition@") for fr in f["frames"])
    # palette finds the segment colours
    hexes = {p["hex"] for p in f["visual"]["palette"]}
    assert len(hexes) >= 3
    a = f["audio"]
    assert a["present"] and (out / "spectrogram.png").is_file() and (out / "audio.wav").is_file()
    assert 6 <= a["onset_count"] <= 10, a["onset_count"]  # 2 Hz click track over 4 s
    assert 100 <= a["tempo_estimate_bpm"]["value"] <= 140  # 2 Hz = 120 BPM
    assert a["transcript"] is None  # prep never pretends to have listened


def test_prep_is_resumable_and_handles_silent_single_shot(tmp_path):
    v = make_video(tmp_path / "s.mp4", cuts=[], total=2.0, audio=False)
    f = prep_video(v, tmp_path / "p", DEFAULTS["prep"])
    assert f["cuts"] == [] and f["rhythm"]["shot_count"] == 1 and f["audio"] == {"present": False}
    mtime = (tmp_path / "p" / "s" / "facts.json").stat().st_mtime
    prep_video(v, tmp_path / "p", DEFAULTS["prep"])
    assert (tmp_path / "p" / "s" / "facts.json").stat().st_mtime == mtime
