import http.server
import socketserver
import subprocess
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
CUTS = [1.0, 2.5, 3.0]  # known hard-cut times in the synthetic fixture


def make_video(path: Path, cuts=CUTS, total=4.0, audio=True, beat_hz=2.0):
    """Colour segments with hard cuts at `cuts`, plus (optionally) a 2 Hz click track."""
    colors = ["red", "blue", "green", "yellow"]
    bounds = [0.0, *cuts, total]
    segs = []
    for i in range(len(bounds) - 1):
        segs.append(f"color=c={colors[i % 4]}:s=320x568:r=24:d={bounds[i+1]-bounds[i]}")
    inputs = []
    for s in segs:
        inputs += ["-f", "lavfi", "-i", s]
    n = len(segs)
    fc = "".join(f"[{i}:v]" for i in range(n)) + f"concat=n={n}:v=1:a=0[v]"
    cmd = ["ffmpeg", "-v", "error", "-y", *inputs]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"aevalsrc='if(lt(mod(t,{1/beat_hz}),0.03),0.9*sin(2*PI*1000*t),0)':s=44100:d={total}"]
    cmd += ["-filter_complex", fc, "-map", "[v]"]
    if audio:
        cmd += ["-map", f"{n}:a", "-c:a", "aac"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", str(total), str(path)]
    subprocess.run(cmd, check=True)
    return path


@pytest.fixture(scope="session")
def fixture_video(tmp_path_factory):
    return make_video(tmp_path_factory.mktemp("fx") / "clip.mp4")


@pytest.fixture(scope="session")
def mock_site(tmp_path_factory, fixture_video):
    """A fake 'reels' site on localhost (NOT Instagram): feed page + per-reel permalink pages with <video>."""
    import shutil
    web = tmp_path_factory.mktemp("web")
    reels = [("AAAAA11111", "motion.studio", "Kinetic typography title sequence, After Effects breakdown"),
             ("BBBBB22222", "memes.daily", "funny meme prank compilation"),
             ("CCCCC33333", "brand.films", "Product film commercial campaign, cinematic 3D render")]
    for code, _, _ in reels:
        shutil.copy(fixture_video, web / f"{code}.mp4")
    controls = ('<div role="button" onclick="t(this,\'Like\',\'Unlike\')"><svg aria-label="Like" width="24" height="24"></svg></div>'
                '<div role="button" onclick="t(this,\'Save\',\'Remove\')"><svg aria-label="Save" width="24" height="24"></svg></div>'
                '<div role="button" onclick="this.textContent=\'Following\'">Follow</div>')
    sections = "".join(
        f'<section class="reel" style="height:100vh;scroll-snap-align:start;position:relative"><video src="/{c}.mp4" muted loop autoplay playsinline '
        f'style="height:90vh"></video><div><a href="/{u}/">{u}</a> <a href="/reel/{c}/">link</a><p>{cap}</p><div style="position:absolute;top:40%;right:10px">{controls}</div></div></section>'
        for c, u, cap in reels)
    (web / "reels.html").write_text(
        "<html><body style='margin:0'><div id=f style='height:100vh;overflow-y:scroll;scroll-snap-type:y mandatory'>"
        f"{sections}</div><script>addEventListener('keydown',e=>{{if(e.key==='ArrowDown')"
        "document.getElementById('f').scrollBy(0,innerHeight)});"
        "function t(d,a,b){const s=d.querySelector('svg');s.setAttribute('aria-label',s.getAttribute('aria-label')===a?b:a)}</script></body></html>")
    for c, u, cap in reels:
        d = web / "reel" / c
        d.mkdir(parents=True)
        (d / "index.html").write_text(
            f'<html><head><meta property="og:description" content="{cap}"><meta property="og:video" content="/{c}.mp4">'
            f'<title>{c}</title></head><body><video src="/{c}.mp4" controls></video></body></html>')

    def tile(code):
        return f'<a href="/p/{code}/"><svg aria-label="Clip"></svg></a>'
    def page(path, html):
        d = web / path
        d.mkdir(parents=True, exist_ok=True)
        (d / "index.html").write_text(f"<html><body><main>{html}</main></body></html>")
    page("your_instagram_username/saved", '<a href="/your_instagram_username/saved/motion/178/">Motion</a><a href="/your_instagram_username/saved/all-posts/">All posts</a>')
    page("your_instagram_username/saved/motion/178", tile("AAAAA11111") + tile("CCCCC33333"))
    page("your_instagram_username/saved/all-posts", "".join(tile(c) for c, _, _ in reels))
    page("motion.studio/reels", '<a href="/motion.studio/reel/AAAAA11111/"><svg aria-label="Clip"></svg></a>')
    page("brand.films/reels", '<a href="/brand.films/reel/CCCCC33333/"><svg aria-label="Clip"></svg></a>')
    for c, u, cap in reels:  # permalinks also reachable as /p/<code>/
        shutil.copytree(web / "reel" / c, web / "p" / c)

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(web), **k)
        def log_message(self, *a):
            pass

    class S(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    srv = S(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield {"base": f"http://127.0.0.1:{srv.server_address[1]}", "reels": reels}
    srv.shutdown()


def make_cfg(tmp_path, base=None, **collector):
    from vie.config import load_config
    cfg = load_config(root=tmp_path, env={})
    cfg.data["paths"]["sessions_dir"] = str(tmp_path / "scroll-sessions")
    cfg.data["paths"]["state_dir"] = str(tmp_path / "state")
    cfg.data["browser"]["headless"] = True
    cfg.data["collector"].update(dwell_s=[0.1, 0.2], fast_dwell_s=[0.2, 0.3], retry_backoff_s=[0.1],
                                 progress_every_s=1, grid_scroll_pause_s=0.3, **collector)
    cfg.data["instagram"]["account"] = "your_instagram_username"
    if base:
        cfg.data["instagram"].update(base_url=base, start_url=base + "/reels.html")
    return cfg
