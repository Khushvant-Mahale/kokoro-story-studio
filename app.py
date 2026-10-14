import json
import asyncio
from pathlib import Path
from aiohttp import web

from core.kokoro_engine import KokoroEngine
from core.project_manager import ProjectManager

BASE_DIR = Path(__file__).resolve().parent
STUDIO_DIR = BASE_DIR / "studio"
CACHE_DIR = BASE_DIR / "cache"
OUTPUT_DIR = BASE_DIR / "output"
SAMPLES_DIR = OUTPUT_DIR / "samples"
VOICES_FILE = BASE_DIR / "core" / "voices_metadata.json"
CONFIG_FILE = BASE_DIR / "projects" / "config.json"

engine: KokoroEngine = None
project_mgr = ProjectManager()


def load_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"remote_worker_url": ""}


def save_config(cfg: dict):
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)


async def init_engine():
    global engine
    if engine is None:
        engine = KokoroEngine()
        cfg = load_config()
        remote_url = cfg.get("remote_worker_url", "").strip()
        if remote_url:
            engine.remote_url = remote_url
            print(f"[Kokoro Studio] Active remote GPU worker: {remote_url}")


@web.middleware
async def no_cache_middleware(request, handler):
    resp = await handler(request)
    if request.path.startswith("/studio") or request.path == "/" or request.path.startswith("/projects"):
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp


# ---------------- API HANDLERS ---------------- #

async def handle_index(request):
    resp = web.FileResponse(STUDIO_DIR / "index.html")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


async def handle_get_voices(request):
    if not VOICES_FILE.exists():
        return web.json_response([])
    with open(VOICES_FILE, "r", encoding="utf-8") as f:
        voices = json.load(f)
    return web.json_response(voices)


async def handle_synthesize_block(request):
    data = await request.json()
    text = data.get("text", "").strip()
    voice_id = data.get("voice_id", "am_fenrir")
    blend_weights = data.get("blend_weights")
    speed = float(data.get("speed", 0.90))
    gain = float(data.get("gain", 1.0))
    pitch_shift = float(data.get("pitch_shift", 0.0))
    warmth = float(data.get("warmth", 0.0))
    clarity = float(data.get("clarity", 0.0))
    reverb = float(data.get("reverb", 0.0))
    radio_fx = bool(data.get("radio_fx", False))
    fx_filter = str(data.get("fx_filter") or ("radio" if radio_fx else "none")).strip().lower()

    if not text:
        return web.json_response({"error": "Text is required"}, status=400)

    try:
        res = await asyncio.to_thread(
            engine.synthesize_block,
            text=text,
            voice_id=voice_id,
            blend_weights=blend_weights,
            speed=speed,
            gain=gain,
            pitch_shift=pitch_shift,
            warmth=warmth,
            clarity=clarity,
            reverb=reverb,
            radio_fx=radio_fx,
            fx_filter=fx_filter
        )
        return web.json_response(res)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_blend_preview(request):
    data = await request.json()
    text = data.get("text", "This is an audition sample for your custom voice blend.").strip()
    blend_weights = data.get("blend_weights", {"am_fenrir": 0.5, "am_onyx": 0.5})
    speed = float(data.get("speed", 0.90))
    pitch_shift = float(data.get("pitch_shift", 0.0))
    warmth = float(data.get("warmth", 0.0))
    clarity = float(data.get("clarity", 0.0))
    reverb = float(data.get("reverb", 0.0))
    radio_fx = bool(data.get("radio_fx", False))
    fx_filter = str(data.get("fx_filter") or ("radio" if radio_fx else "none")).strip().lower()

    try:
        res = await asyncio.to_thread(
            engine.synthesize_block,
            text=text,
            voice_id="custom_blend",
            blend_weights=blend_weights,
            speed=speed,
            gain=1.0,
            pitch_shift=pitch_shift,
            warmth=warmth,
            clarity=clarity,
            reverb=reverb,
            radio_fx=radio_fx,
            fx_filter=fx_filter
        )
        return web.json_response(res)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_export_master(request):
    data = await request.json()
    blocks = data.get("blocks", [])
    filename = data.get("filename", "master_narrative.wav")

    if not blocks:
        return web.json_response({"error": "No blocks provided"}, status=400)

    try:
        res = await asyncio.to_thread(
            engine.compile_master_track,
            blocks,
            filename=filename
        )
        return web.json_response(res)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_export_zip(request):
    data = await request.json()
    blocks = data.get("blocks", [])
    filename = data.get("filename", "story_sentences.zip")

    if not blocks:
        return web.json_response({"error": "No blocks provided"}, status=400)

    try:
        res = await asyncio.to_thread(
            engine.export_blocks_as_zip,
            blocks,
            filename=filename
        )
        return web.json_response(res)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_get_projects(request):
    projs = project_mgr.list_projects()
    return web.json_response(projs)


async def handle_create_project(request):
    data = await request.json()
    title = data.get("title", "Untitled Project").strip() or "Untitled Project"
    raw_text = data.get("text", "").strip()
    defaults = data.get("defaults") or data.get("default_settings") or {}
    default_voice = data.get("default_voice") or defaults.get("voice_id", "blend_fenrir_onyx")
    default_voice = default_voice.strip() if isinstance(default_voice, str) else "blend_fenrir_onyx"
    
    # Generate ID
    import uuid
    proj_id = f"proj_{uuid.uuid4().hex[:8]}"
    
    blocks = []
    if "blocks" in data and isinstance(data["blocks"], list) and len(data["blocks"]) > 0:
        blocks = data["blocks"]
    elif raw_text:
        blocks = project_mgr.split_text_into_blocks(raw_text, default_voice=default_voice, defaults=defaults)
    else:
        def_speed = float(defaults.get("speed", 0.90)) if defaults and "speed" in defaults else 0.90
        def_gain = float(defaults.get("gain", 1.0)) if defaults and "gain" in defaults else 1.0
        def_pause = float(defaults.get("pause_after", 0.6)) if defaults and "pause_after" in defaults else 0.6
        def_pitch = float(defaults.get("pitch_shift", 0.0)) if defaults and "pitch_shift" in defaults else 0.0
        def_warmth = float(defaults.get("warmth", 0.0)) if defaults and "warmth" in defaults else 0.0
        def_clarity = float(defaults.get("clarity", 0.0)) if defaults and "clarity" in defaults else 0.0
        def_reverb = float(defaults.get("reverb", 0.0)) if defaults and "reverb" in defaults else 0.0
        def_filter = str(defaults.get("fx_filter", "none")) if defaults and "fx_filter" in defaults else "none"
        def_radio = bool(defaults.get("radio_fx", False)) if defaults and "radio_fx" in defaults else (def_filter == "radio")
        
        b1 = {
            "id": "b_1",
            "text": "Start typing your first story sentence here...",
            "voice_id": default_voice,
            "speed": round(def_speed, 2),
            "gain": round(def_gain, 2),
            "pause_after": round(def_pause, 1),
            "pitch_shift": round(def_pitch, 1),
            "warmth": round(def_warmth, 1),
            "clarity": round(def_clarity, 1),
            "reverb": round(def_reverb, 2),
            "fx_filter": def_filter,
            "radio_fx": def_radio
        }
        if defaults and defaults.get("blend_weights"):
            b1["blend_weights"] = defaults["blend_weights"]
        blocks = [b1]
    
    proj_data = {
        "id": proj_id,
        "title": title,
        "default_voice": default_voice,
        "default_settings": defaults if defaults else None,
        "blocks": blocks,
        "master_filename": f"{proj_id}_master.wav"
    }
    project_mgr.save_project(proj_data, proj_id)
    return web.json_response(proj_data)


async def handle_delete_project(request):
    proj_id = request.match_info["id"]
    success = project_mgr.delete_project(proj_id)
    return web.json_response({"deleted": success, "id": proj_id})


async def handle_get_project(request):
    proj_id = request.query.get("id", "default")
    proj = project_mgr.load_project(proj_id)
    return web.json_response(proj)


async def handle_save_project(request):
    data = await request.json()
    proj_id = data.get("id", "default")
    project_mgr.save_project(data, proj_id)
    return web.json_response({"status": "saved", "id": proj_id})


async def handle_split_text(request):
    data = await request.json()
    text = data.get("text", "")
    defaults = data.get("defaults") or data.get("default_settings") or {}
    default_voice = data.get("default_voice") or defaults.get("voice_id", "blend_fenrir_onyx")
    default_voice = default_voice.strip() if isinstance(default_voice, str) else "blend_fenrir_onyx"
    blocks = project_mgr.split_text_into_blocks(text, default_voice=default_voice, defaults=defaults)
    return web.json_response(blocks)


async def handle_auto_direct(request):
    data = await request.json()
    blocks = data.get("blocks", [])
    defaults = data.get("defaults") or data.get("default_settings") or {}
    default_voice = data.get("default_voice") or defaults.get("voice_id", "blend_fenrir_onyx")
    default_voice = default_voice.strip() if isinstance(default_voice, str) else "blend_fenrir_onyx"
    expand_dialogue = bool(data.get("expand_dialogue", False))
    directed = project_mgr.auto_direct_blocks(blocks, default_voice=default_voice, expand_dialogue=expand_dialogue, defaults=defaults)
    return web.json_response(directed)


async def handle_merge_short(request):
    data = await request.json()
    blocks = data.get("blocks", [])
    max_chars = int(data.get("max_chars", 35))
    max_words = int(data.get("max_words", 5))
    merged = project_mgr.merge_ultra_small_blocks(blocks, max_chars=max_chars, max_words=max_words)
    return web.json_response(merged)


async def handle_get_audio(request):
    filename = request.match_info["filename"]
    # Look in cache, output, and samples
    candidates = [
        CACHE_DIR / filename,
        OUTPUT_DIR / filename,
        SAMPLES_DIR / filename
    ]
    for p in candidates:
        if p.exists():
            if p.suffix == ".zip":
                content_type = "application/zip"
            elif p.suffix == ".wav":
                content_type = "audio/wav"
            else:
                content_type = "audio/mpeg"
            headers = {
                "Content-Type": content_type,
                "Accept-Ranges": "bytes",
                "Cache-Control": "public, max-age=31536000, immutable"
            }
            if p.suffix == ".zip":
                headers["Content-Disposition"] = f'attachment; filename="{p.name}"'
            return web.FileResponse(p, headers=headers)

    return web.Response(text="Audio file not found", status=404)


async def handle_get_config(request):
    cfg = load_config()
    remote_url = engine.remote_url if engine else cfg.get("remote_worker_url", "")
    return web.json_response({
        "remote_worker_url": remote_url or "",
        "active": bool(remote_url)
    })


async def handle_save_config(request):
    data = await request.json()
    url = data.get("remote_worker_url", "").strip()
    cfg = load_config()
    cfg["remote_worker_url"] = url
    save_config(cfg)
    if engine:
        engine.remote_url = url if url else None
    return web.json_response({
        "status": "saved",
        "remote_worker_url": engine.remote_url or "",
        "active": bool(engine.remote_url)
    })


async def handle_test_remote(request):
    data = await request.json()
    test_url = data.get("url", "").strip() or (engine.remote_url if engine else "")
    if not test_url:
        return web.json_response({"ok": False, "error": "No remote URL provided"}, status=400)

    import urllib.request
    try:
        health_endpoint = f"{test_url.rstrip('/')}/health"
        req = urllib.request.Request(
            health_endpoint,
            headers={"User-Agent": "KokoroStudio/1.0"}
        )

        def _check():
            with urllib.request.urlopen(req, timeout=6) as resp:
                if resp.status == 200:
                    return json.loads(resp.read().decode("utf-8"))
                return None

        res = await asyncio.to_thread(_check)
        if res:
            return web.json_response({"ok": True, "details": res})
        return web.json_response({"ok": False, "error": "Unexpected response from worker"}, status=502)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=502)


async def handle_get_colab_script(request):
    colab_file = BASE_DIR / "colab_worker.py"
    if colab_file.exists():
        with open(colab_file, "r", encoding="utf-8") as f:
            content = f.read()
        return web.Response(text=content, content_type="text/plain")
    return web.Response(text="# Colab worker script not found", status=404)


async def handle_get_sample_story(request):
    sample_file = BASE_DIR / "input" / "THE ENDLESS ECLIPSE - Sample.txt"
    if not sample_file.exists():
        sample_file = BASE_DIR / "input" / "THE ENDLESS ECLIPSE.txt"
    if sample_file.exists():
        with open(sample_file, "r", encoding="utf-8-sig") as f:
            content = f.read()
        return web.json_response({
            "title": "The Endless Eclipse - Sample",
            "text": content
        })
    return web.json_response({"error": "Sample file not found"}, status=404)


async def handle_favicon(request):
    fav_file = STUDIO_DIR / "favicon.svg"
    if fav_file.exists():
        return web.FileResponse(fav_file, headers={"Content-Type": "image/svg+xml", "Cache-Control": "max-age=86400"})
    return web.Response(status=404)


# ---------------- APP FACTORY ---------------- #

def create_app():
    app = web.Application(middlewares=[no_cache_middleware])
    app.router.add_get("/", handle_index)
    app.router.add_get("/studio", handle_index)
    app.router.add_get("/studio/", handle_index)
    app.router.add_get("/projects", handle_index)
    app.router.add_get("/favicon.ico", handle_favicon)
    app.router.add_get("/studio/favicon.svg", handle_favicon)
    app.router.add_get("/api/voices", handle_get_voices)
    app.router.add_post("/api/synthesize_block", handle_synthesize_block)
    app.router.add_post("/api/blend_preview", handle_blend_preview)
    app.router.add_post("/api/export_master", handle_export_master)
    app.router.add_post("/api/export_zip", handle_export_zip)
    app.router.add_get("/api/projects", handle_get_projects)
    app.router.add_post("/api/projects/new", handle_create_project)
    app.router.add_delete("/api/projects/{id}", handle_delete_project)
    app.router.add_get("/api/project", handle_get_project)
    app.router.add_post("/api/project", handle_save_project)
    app.router.add_post("/api/split_text", handle_split_text)
    app.router.add_post("/api/auto_direct", handle_auto_direct)
    app.router.add_post("/api/merge_short", handle_merge_short)
    app.router.add_get("/api/audio/{filename}", handle_get_audio)
    app.router.add_get("/api/config", handle_get_config)
    app.router.add_post("/api/config", handle_save_config)
    app.router.add_post("/api/test_remote", handle_test_remote)
    app.router.add_get("/api/colab_script", handle_get_colab_script)
    app.router.add_get("/api/sample_story", handle_get_sample_story)

    # Static assets
    app.router.add_static("/studio", STUDIO_DIR)

    return app


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Kokoro Studio Server")
    parser.add_argument("--port", type=int, default=7860, help="Port to listen on (default 7860)")
    parser.add_argument("--test", action="store_true", help="Initialize and exit for testing")
    args = parser.parse_args()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(init_engine())

    if args.test:
        print("[Kokoro Studio] Self-test passed successfully.")
        exit(0)

    app = create_app()
    print("\n=======================================================")
    print(f"  Kokoro Story Studio running at: http://localhost:{args.port}")
    print("=======================================================\n")
    web.run_app(app, host="127.0.0.1", port=args.port)
