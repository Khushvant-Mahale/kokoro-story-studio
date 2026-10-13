"""
Kokoro Cloud GPU Worker for Google Colab & Kaggle
==================================================
Run this 1-click script in a free Google Colab notebook (with T4 GPU enabled)
or Kaggle notebook to get 100x faster Kokoro TTS generation (~200ms per sentence).

How to use in Google Colab:
1. Open https://colab.research.google.com and create a New Notebook.
2. In the top menu, go to: Runtime -> Change runtime type -> Select "T4 GPU" -> Save.
3. Copy and paste this ENTIRE code into a cell, then press Shift+Enter (Run).
4. In ~30-45 seconds, you will see a public Cloudflare tunnel URL:
   e.g. https://xxxx-xxxx-xxxx.trycloudflare.com
5. Copy that URL, open your Kokoro Story Studio, click the Engine badge in the top bar,
   paste the URL, and click "Save & Activate".
"""

import os
import sys
import io
import re
import time
import asyncio
import urllib.request
import subprocess
from pathlib import Path
import numpy as np

# ----------------- 1. AUTO-INSTALL PREREQUISITES ----------------- #
print("==================================================================")
print("  Kokoro Cloud GPU Worker — Initializing Environment")
print("==================================================================")

import logging
logging.getLogger("phonemizer").setLevel(logging.ERROR)

def run_cmd(cmd):
    return subprocess.run(cmd, shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

# Check CUDA / GPU
try:
    import torch
    has_cuda = torch.cuda.is_available()
    gpu_name = torch.cuda.get_device_name(0) if has_cuda else "CPU"
except Exception:
    has_cuda = False
    gpu_name = "CPU"

print(f"🖥️ Detected Hardware: {gpu_name} (CUDA available: {has_cuda})")

# Ensure onnxruntime-gpu is installed WITHOUT CPU onnxruntime collision
needs_install = False
try:
    import fastapi
    import uvicorn
    import pycloudflared
    import soundfile
    import onnxruntime as ort
    from kokoro_onnx import Kokoro
    if has_cuda and "CUDAExecutionProvider" not in ort.get_available_providers():
        needs_install = True
except ImportError:
    needs_install = True

if needs_install:
    print("📦 Setting up libraries with GPU CUDA support...")
    if has_cuda:
        run_cmd(f"{sys.executable} -m pip uninstall -y -q onnxruntime onnxruntime-gpu")
        run_cmd(f"{sys.executable} -m pip install -q --no-cache-dir onnxruntime-gpu==1.19.2")
    else:
        run_cmd(f"{sys.executable} -m pip install -q onnxruntime")

    run_cmd(f"{sys.executable} -m pip install -q fastapi uvicorn pycloudflared soundfile numpy espeakng-loader phonemizer")
    run_cmd(f"{sys.executable} -m pip install -q --no-deps kokoro-onnx")

    import fastapi
    import uvicorn
    import pycloudflared
    import soundfile
    from kokoro_onnx import Kokoro

import onnxruntime as ort

# Configure CUDA provider options to prevent cuDNN Frontend 9 heuristic crashes on Turing T4
if has_cuda and "CUDAExecutionProvider" in ort.get_available_providers():
    cuda_options = {
        "device_id": 0,
        "cudnn_conv_algo_search": "DEFAULT",  # Bypasses cuDNN 9 frontend heuristic failure, uses standard fast GEMM
        "arena_extend_strategy": "kNextPowerOfTwo",
        "do_copy_in_default_stream": True,
    }
    providers = [("CUDAExecutionProvider", cuda_options), "CPUExecutionProvider"]
else:
    providers = ["CPUExecutionProvider"]

print(f"⚡ ONNX Runtime Execution Providers: {providers}")

if has_cuda and "CUDAExecutionProvider" not in ort.get_available_providers():
    print("\n" + "=" * 70)
    print("  ⚠️ IMPORTANT FOR 100x SPEED:")
    print("  ONNX Runtime CPU was loaded in this session before GPU setup.")
    print("  👉 Click Colab menu: Runtime -> Restart session (or press Ctrl+M .)")
    print("  Then press 'Run' again to activate full Tesla T4 GPU acceleration!")
    print("=" * 70 + "\n")

# ----------------- 2. DOWNLOAD MODEL & VOICE WEIGHTS ----------------- #
MODEL_FILE = Path("kokoro-v0_19.onnx")
VOICES_FILE = Path("voices-v1.0.bin")

if not MODEL_FILE.exists():
    print("📥 Downloading Kokoro ONNX model weights (~83MB)...")
    url = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files/kokoro-v0_19.onnx"
    urllib.request.urlretrieve(url, str(MODEL_FILE))

if not VOICES_FILE.exists():
    print("📥 Downloading voices tensor package (~28MB)...")
    url = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin"
    urllib.request.urlretrieve(url, str(VOICES_FILE))

print("✅ Model files verified on disk.")

# ----------------- 3. INITIALIZE KOKORO ENGINE ----------------- #
print("🧠 Initializing Kokoro Neural Engine on GPU session...")
sess_options = ort.SessionOptions()
sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
session = ort.InferenceSession(str(MODEL_FILE), sess_options=sess_options, providers=providers)
kokoro = Kokoro.from_session(session, str(VOICES_FILE))

# Preset voice blends for story narration
PRESET_BLENDS = {
    "blend_fenrir_onyx": {"am_fenrir": 0.60, "am_onyx": 0.40},
    "blend_adam_onyx": {"am_adam": 0.65, "am_onyx": 0.35},
    "blend_george_onyx": {"bm_george": 0.70, "am_onyx": 0.30}
}
voice_cache = {}

def get_voice_vector(voice_id: str, blend_weights=None):
    if not blend_weights and voice_id in PRESET_BLENDS:
        blend_weights = PRESET_BLENDS[voice_id]

    if blend_weights:
        bkey = "blend_" + "_".join(f"{k}:{v:.2f}" for k, v in sorted(blend_weights.items()))
        if bkey in voice_cache:
            return voice_cache[bkey]
        vec = None
        tot = sum(blend_weights.values()) or 1.0
        for vid, weight in blend_weights.items():
            try:
                v = kokoro.get_voice_style(vid)
            except Exception:
                v = kokoro.get_voice_style("am_adam")
            nw = weight / tot
            vec = nw * v if vec is None else vec + (nw * v)
        voice_cache[bkey] = vec
        return vec

    if voice_id in voice_cache:
        return voice_cache[voice_id]

    try:
        vec = kokoro.get_voice_style(voice_id)
    except Exception:
        vec = kokoro.get_voice_style("am_adam")
    voice_cache[voice_id] = vec
    return vec

# Warm up engine
try:
    print("🔥 Warming up GPU inference pipeline...")
    t0_w = time.time()
    _ = kokoro.create("Warmup.", voice=get_voice_vector("am_fenrir"), speed=1.0, lang="en-us")
    w_dur = time.time() - t0_w
    active_prov = session.get_providers()
    print(f"⚡ Warmup complete in {w_dur:.3f}s!")
    if "CUDAExecutionProvider" in active_prov and w_dur < 1.5:
        print(f"🚀 TESLA T4 GPU ACCELERATION ACTIVE! (~{w_dur*1000:.0f}ms per sentence)")
    else:
        print(f"ℹ️ Active providers: {active_prov}")
except Exception as e:
    print("Warmup warning:", e)

# ----------------- 3.5 AUDIO DSP (PITCH, EQ, REVERB, RADIO FX) ----------------- #
try:
    import scipy.signal as signal
    HAS_SCIPY = True
except ImportError:
    signal = None
    HAS_SCIPY = False

def phase_vocoder(d, rate, hop_length=256):
    time_steps = np.arange(0, d.shape[1], rate, dtype=np.float64)
    d_stretch = np.zeros((d.shape[0], len(time_steps)), dtype=np.complex128)
    phi_advance = np.linspace(0, np.pi * hop_length, d.shape[0])
    phase_acc = np.angle(d[:, 0])
    padding = [(0, 0), (0, 2)]
    d_padded = np.pad(d, padding, mode="constant")
    for t, step in enumerate(time_steps):
        s = int(step)
        f = step - s
        col1 = d_padded[:, s]
        col2 = d_padded[:, s + 1]
        mag = (1.0 - f) * np.abs(col1) + f * np.abs(col2)
        d_stretch[:, t] = mag * np.exp(1j * phase_acc)
        dphase = np.angle(col2) - np.angle(col1) - phi_advance
        dphase = dphase - 2.0 * np.pi * np.round(dphase / (2.0 * np.pi))
        phase_acc += phi_advance + dphase
    return d_stretch

def process_audio_fx(samples, sr=24000, pitch_shift_st=0.0, warmth_db=0.0, clarity_db=0.0, reverb_wet=0.0, radio_fx=False, fx_filter="none"):
    if samples is None or len(samples) == 0:
        return samples
    out = samples.copy()
    if HAS_SCIPY and abs(pitch_shift_st) >= 0.05 and len(out) >= 512:
        try:
            factor = 2.0 ** (float(pitch_shift_st) / 12.0)
            n_fft, hop = 1024, 256
            _, _, zxx = signal.stft(out, fs=sr, nperseg=n_fft, noverlap=n_fft - hop)
            z_stretch = phase_vocoder(zxx, factor, hop_length=hop)
            _, y_stretch = signal.istft(z_stretch, fs=sr, nperseg=n_fft, noverlap=n_fft - hop)
            target_len = len(out)
            out = signal.resample(y_stretch, target_len).astype(np.float32) if len(y_stretch) != target_len else y_stretch.astype(np.float32)
        except Exception:
            pass

    if HAS_SCIPY and (abs(warmth_db) >= 0.1 or abs(clarity_db) >= 0.1):
        try:
            if abs(warmth_db) >= 0.1:
                A = 10.0 ** (float(warmth_db) / 40.0)
                w0 = 2.0 * np.pi * 220.0 / sr
                alpha = np.sin(w0) / (2.0 * 0.707)
                cos_w0 = np.cos(w0)
                a0 = (A + 1.0) + (A - 1.0) * cos_w0 + 2.0 * np.sqrt(A) * alpha
                b0 = A * ((A + 1.0) - (A - 1.0) * cos_w0 + 2.0 * np.sqrt(A) * alpha)
                b1 = 2.0 * A * ((A - 1.0) - (A + 1.0) * cos_w0)
                b2 = A * ((A + 1.0) - (A - 1.0) * cos_w0 - 2.0 * np.sqrt(A) * alpha)
                a1 = -2.0 * ((A - 1.0) + (A + 1.0) * cos_w0)
                a2 = (A + 1.0) + (A - 1.0) * cos_w0 - 2.0 * np.sqrt(A) * alpha
                out = signal.lfilter(np.array([b0, b1, b2]) / a0, np.array([a0, a1, a2]) / a0, out)
            if abs(clarity_db) >= 0.1:
                A = 10.0 ** (float(clarity_db) / 40.0)
                w0 = 2.0 * np.pi * 4500.0 / sr
                alpha = np.sin(w0) / (2.0 * 0.707)
                cos_w0 = np.cos(w0)
                a0 = (A + 1.0) - (A - 1.0) * cos_w0 + 2.0 * np.sqrt(A) * alpha
                b0 = A * ((A + 1.0) + (A - 1.0) * cos_w0 + 2.0 * np.sqrt(A) * alpha)
                b1 = -2.0 * A * ((A - 1.0) + (A + 1.0) * cos_w0)
                b2 = A * ((A + 1.0) + (A - 1.0) * cos_w0 - 2.0 * np.sqrt(A) * alpha)
                a1 = 2.0 * ((A - 1.0) - (A + 1.0) * cos_w0)
                a2 = (A + 1.0) - (A - 1.0) * cos_w0 - 2.0 * np.sqrt(A) * alpha
                out = signal.lfilter(np.array([b0, b1, b2]) / a0, np.array([a0, a1, a2]) / a0, out)
        except Exception:
            pass

    filt = str(fx_filter or "none").strip().lower()
    if filt == "none" and radio_fx:
        filt = "radio"

    if HAS_SCIPY and len(out) >= 64:
        try:
            nyq = sr / 2.0
            if filt == "radio":
                b, a = signal.butter(4, [400.0 / nyq, 3400.0 / nyq], btype="band")
                out = np.tanh(signal.lfilter(b, a, out) * 1.6) * 0.85
            elif filt == "whisper":
                b, a = signal.butter(3, 350.0 / nyq, btype="high")
                out = signal.lfilter(b, a, out) * 0.75
            elif filt == "scream":
                out = np.tanh(out * 2.5) * 0.95
            elif filt == "demon":
                out = np.tanh(out * 1.8) * 0.92
            elif filt == "youth":
                b, a = signal.butter(2, 240.0 / nyq, btype="high")
                out = signal.lfilter(b, a, out)
        except Exception:
            pass

    if HAS_SCIPY and reverb_wet > 0.02 and len(out) >= 1000:
        try:
            wet = min(float(reverb_wet), 0.50)
            comb_delays = [int(sr * d) for d in [0.0297, 0.0371, 0.0411, 0.0437]]
            comb_gains = [0.75, 0.73, 0.71, 0.69]
            accum = np.zeros_like(out)
            for d, g in zip(comb_delays, comb_gains):
                b = np.zeros(d + 1); b[0] = 1.0
                a = np.zeros(d + 1); a[0] = 1.0; a[d] = -g
                accum += signal.lfilter(b, a, out)
            comb_out = accum / len(comb_delays)
            ap_d = int(sr * 0.005)
            ap_b = np.zeros(ap_d + 1); ap_b[0] = -0.7; ap_b[ap_d] = 1.0
            ap_a = np.zeros(ap_d + 1); ap_a[0] = 1.0; ap_a[ap_d] = -0.7
            wet_sig = signal.lfilter(ap_b, ap_a, comb_out)
            out = (1.0 - wet) * out + (wet * 1.2) * wet_sig
        except Exception:
            pass

    return np.clip(out, -1.0, 1.0).astype(np.float32)

# ----------------- 4. FASTAPI MICROSERVICE ----------------- #
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pycloudflared import try_cloudflare
import threading

app = FastAPI(title="Kokoro Cloud GPU Worker")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "worker": "Kokoro-GPU-Cloud-Worker",
        "hardware": gpu_name,
        "cuda": has_cuda,
        "providers": session.get_providers(),
        "timestamp": time.time()
    }

@app.post("/synthesize")
async def synthesize(req: Request):
    data = await req.json()
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
    lang = data.get("lang", "en-us")

    if not text:
        return Response(content=b"", status_code=400)

    t0 = time.time()
    voice_vec = get_voice_vector(voice_id, blend_weights)
    clean = text.strip()

    # Offload inference to worker thread so asyncio event loop stays non-blocking for concurrent parallel requests
    def _run_inference():
        if len(clean) > 120 and any(p in clean for p in [". ", "? ", "! ", "... "]):
            sentences = [s.strip() for s in re.split(r'(?<=[.!?])\s+|\n+', clean) if s.strip()]
            if len(sentences) > 1:
                all_samples = []
                sr = 24000
                for s in sentences:
                    sub_samples, sr = kokoro.create(s, voice=voice_vec, speed=speed, lang=lang)
                    all_samples.append(sub_samples)
                    all_samples.append(np.zeros(int(sr * 0.08), dtype=np.float32))
                s_arr = np.concatenate(all_samples)
                s_rate = sr
            else:
                s_arr, s_rate = kokoro.create(clean, voice=voice_vec, speed=speed, lang=lang)
        else:
            s_arr, s_rate = kokoro.create(clean, voice=voice_vec, speed=speed, lang=lang)

        if gain != 1.0:
            s_arr = s_arr * gain

        # Apply voice audio DSP
        s_arr = process_audio_fx(
            s_arr,
            sr=s_rate,
            pitch_shift_st=pitch_shift,
            warmth_db=warmth,
            clarity_db=clarity,
            reverb_wet=reverb,
            radio_fx=radio_fx,
            fx_filter=fx_filter
        )

        buf = io.BytesIO()
        soundfile.write(buf, s_arr, s_rate, format="WAV")
        return buf.getvalue()

    audio_bytes = await asyncio.to_thread(_run_inference)
    elapsed = time.time() - t0
    print(f"⚡ Synthesized '{text[:30]}...' in {elapsed:.3f}s on {gpu_name}")

    return Response(
        content=audio_bytes,
        media_type="audio/wav",
        headers={
            "X-Inference-Time": f"{elapsed:.3f}",
            "X-Hardware": gpu_name
        }
    )

# ----------------- 5. LAUNCH TUNNEL & RUN SERVER ----------------- #
PORT = 8000

def start_server():
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")

server_thread = threading.Thread(target=start_server, daemon=True)
server_thread.start()
time.sleep(2)

print("\n🚀 Establishing Cloudflare HTTPS secure tunnel...")
tunnel = try_cloudflare(port=PORT)
tunnel_url = getattr(tunnel, "tunnel", str(tunnel)).strip()

print("\n" + "=" * 76)
print("  🎉 KOKORO CLOUD GPU WORKER IS NOW ONLINE & ACCELERATED!")
print("=" * 76)
print(f"  ⚡ Hardware:     {gpu_name}")
print(f"  ⚡ Providers:    {providers}")
print(f"  🌐 TUNNEL URL:   {tunnel_url}")
print("=" * 76)
print("  📋 NEXT STEP: Copy the TUNNEL URL above, open Kokoro Story Studio,")
print("  click the '⚡ Local CPU Engine' badge in the top bar,")
print("  paste the URL, and click 'Save & Activate'.")
print("=" * 76 + "\n")

# Keep the main notebook thread alive
try:
    while True:
        time.sleep(60)
except KeyboardInterrupt:
    print("Worker stopped.")
