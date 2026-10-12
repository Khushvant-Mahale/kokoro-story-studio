import os
import re
import hashlib
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Union
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

BASE_DIR = Path(__file__).resolve().parent.parent
MODELS_DIR = BASE_DIR / "models"
CACHE_DIR = BASE_DIR / "cache"
OUTPUT_DIR = BASE_DIR / "output"

CACHE_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


class KokoroEngine:
    def __init__(self):
        model_path = MODELS_DIR / "kokoro-v0_19.onnx"
        voices_path = MODELS_DIR / "voices-v1.0.bin"

        if not model_path.exists():
            raise FileNotFoundError(f"Model file missing: {model_path}")
        if not voices_path.exists():
            raise FileNotFoundError(f"Voices file missing: {voices_path}")

        import onnxruntime as rt
        import psutil

        physical_cores = psutil.cpu_count(logical=False) or 4
        print(f"[KokoroEngine] Loading model weights from {model_path.name} with {physical_cores} CPU threads...")
        sess_options = rt.SessionOptions()
        sess_options.intra_op_num_threads = physical_cores
        sess_options.inter_op_num_threads = 1
        sess_options.graph_optimization_level = rt.GraphOptimizationLevel.ORT_ENABLE_ALL
        sess_options.execution_mode = rt.ExecutionMode.ORT_SEQUENTIAL

        session = rt.InferenceSession(str(model_path), sess_options=sess_options, providers=["CPUExecutionProvider"])
        self.kokoro = Kokoro.from_session(session, str(voices_path))
        self.sample_rate = 24000
        self._voice_cache: Dict[str, np.ndarray] = {}
        self.remote_url: Optional[str] = None
        
        # Load preset blends from voices_metadata.json
        self.preset_blends: Dict[str, Dict[str, float]] = {
            "blend_fenrir_onyx": {"am_fenrir": 0.60, "am_onyx": 0.40},
            "blend_adam_onyx": {"am_adam": 0.65, "am_onyx": 0.35},
            "blend_george_onyx": {"bm_george": 0.70, "am_onyx": 0.30}
        }
        voices_meta_file = BASE_DIR / "core" / "voices_metadata.json"
        if voices_meta_file.exists():
            try:
                import json
                with open(voices_meta_file, "r", encoding="utf-8") as f:
                    for v in json.load(f):
                        if v.get("is_blend") and v.get("blend_weights"):
                            self.preset_blends[v["id"]] = v["blend_weights"]
            except Exception as e:
                print("[KokoroEngine] Warning loading preset blends:", e)

    def get_voice_vector(self, voice_id: str, blend_weights: Optional[Dict[str, float]] = None) -> np.ndarray:
        """Returns the numpy voice embedding, supporting single voices, preset blends, or custom blends."""
        # Check if voice_id is a known preset blend
        if not blend_weights and voice_id in self.preset_blends:
            blend_weights = self.preset_blends[voice_id]

        if blend_weights:
            # Deterministic cache key for blend
            blend_key = "blend_" + "_".join(f"{k}:{v:.2f}" for k, v in sorted(blend_weights.items()))
            if blend_key in self._voice_cache:
                return self._voice_cache[blend_key]

            vec = None
            total_w = sum(blend_weights.values()) or 1.0
            for vid, weight in blend_weights.items():
                try:
                    v = self.kokoro.get_voice_style(vid)
                except Exception:
                    v = self.kokoro.get_voice_style("am_adam")
                norm_w = weight / total_w
                vec = norm_w * v if vec is None else vec + (norm_w * v)

            self._voice_cache[blend_key] = vec
            return vec

        if voice_id in self._voice_cache:
            return self._voice_cache[voice_id]

        try:
            vec = self.kokoro.get_voice_style(voice_id)
        except Exception:
            # Fallback to default natural narrator
            vec = self.kokoro.get_voice_style("am_adam")

        self._voice_cache[voice_id] = vec
        return vec

    def synthesize_block(
        self,
        text: str,
        voice_id: str,
        blend_weights: Optional[Dict[str, float]] = None,
        speed: float = 0.90,
        gain: float = 1.0,
        lang: str = "en-us"
    ) -> Dict:
        """
        Synthesizes a single text block, caching to disk.
        Returns metadata with duration and audio URL.
        """
        clean_text = text.strip()
        if not clean_text:
            return {"error": "Empty text"}

        # Compute cache hash
        voice_tag = voice_id
        if blend_weights and voice_id not in self.preset_blends:
            voice_tag = "blend_" + "_".join(f"{k}:{v:.2f}" for k, v in sorted(blend_weights.items()))

        cache_str = f"{clean_text}__{voice_tag}__{speed:.2f}__{gain:.2f}"
        cache_hash = hashlib.md5(cache_str.encode("utf-8")).hexdigest()
        cache_file = CACHE_DIR / f"{cache_hash}.wav"

        # Check cache
        if cache_file.exists():
            data, sr = sf.read(str(cache_file))
            duration = len(data) / sr
            return {
                "hash": cache_hash,
                "audio_url": f"/api/audio/{cache_hash}.wav",
                "duration": round(duration, 2),
                "cached": True
            }

        # Check remote GPU worker if configured
        if self.remote_url:
            try:
                import urllib.request
                import json
                remote_endpoint = f"{self.remote_url.rstrip('/')}/synthesize"
                payload = json.dumps({
                    "text": clean_text,
                    "voice_id": voice_id,
                    "blend_weights": blend_weights,
                    "speed": speed,
                    "gain": gain,
                    "lang": lang
                }).encode("utf-8")
                req = urllib.request.Request(
                    remote_endpoint,
                    data=payload,
                    headers={
                        "Content-Type": "application/json",
                        "User-Agent": "KokoroStudio/1.0"
                    }
                )
                with urllib.request.urlopen(req, timeout=7) as response:
                    audio_bytes = response.read()
                    if audio_bytes and len(audio_bytes) > 100:
                        with open(cache_file, "wb") as f:
                            f.write(audio_bytes)
                        data, sr = sf.read(str(cache_file))
                        duration = len(data) / sr
                        return {
                            "hash": cache_hash,
                            "audio_url": f"/api/audio/{cache_hash}.wav",
                            "duration": round(duration, 2),
                            "cached": False,
                            "accelerated_by": "cloud_gpu"
                        }
            except Exception as e:
                print(f"[KokoroEngine] Remote GPU worker failed ({e}), falling back to local CPU...")

        # Synthesize audio locally on CPU
        voice_vec = self.get_voice_vector(voice_id, blend_weights)
        if len(clean_text) > 120 and any(p in clean_text for p in [". ", "? ", "! ", "... "]):
            sentences = [s.strip() for s in re.split(r'(?<=[.!?])\s+|\n+', clean_text) if s.strip()]
            if len(sentences) > 1:
                all_samples = []
                for s in sentences:
                    sub_samples, _ = self.kokoro.create(
                        s,
                        voice=voice_vec,
                        speed=speed,
                        lang=lang
                    )
                    all_samples.append(sub_samples)
                    all_samples.append(np.zeros(int(self.sample_rate * 0.08), dtype=np.float32))
                raw_samples = np.concatenate(all_samples)
            else:
                raw_samples, _ = self.kokoro.create(
                    clean_text,
                    voice=voice_vec,
                    speed=speed,
                    lang=lang
                )
        else:
            raw_samples, _ = self.kokoro.create(
                clean_text,
                voice=voice_vec,
                speed=speed,
                lang=lang
            )

        # Apply gain/volume scaling
        if gain != 1.0:
            raw_samples = raw_samples * gain

        # Save to cache
        sf.write(str(cache_file), raw_samples, self.sample_rate)
        duration = len(raw_samples) / self.sample_rate

        return {
            "hash": cache_hash,
            "audio_url": f"/api/audio/{cache_hash}.wav",
            "duration": round(duration, 2),
            "cached": False
        }

    def compile_master_track(self, blocks: List[Dict], filename: str = "master_narrative.wav") -> Dict:
        """
        Stitches an array of blocks with custom pause_after durations into a single master audio track.
        """
        audio_segments = []

        for b in blocks:
            text = b.get("text", "").strip()
            if not text:
                continue

            voice_id = b.get("voice_id", "am_fenrir")
            blend_weights = b.get("blend_weights")
            speed = float(b.get("speed", 0.90))
            gain = float(b.get("gain", 1.0))
            pause_after = float(b.get("pause_after", 0.6))

            # Fetch or generate block audio
            res = self.synthesize_block(text, voice_id, blend_weights, speed, gain)
            cache_file = CACHE_DIR / f"{res['hash']}.wav"
            samples, _ = sf.read(str(cache_file))
            audio_segments.append(samples)

            # Insert pause
            if pause_after > 0:
                silence = np.zeros(int(self.sample_rate * pause_after), dtype=np.float32)
                audio_segments.append(silence)

        if not audio_segments:
            return {"error": "No valid audio blocks to compile"}

        master = np.concatenate(audio_segments)
        output_path = OUTPUT_DIR / filename
        sf.write(str(output_path), master, self.sample_rate)

        total_duration = len(master) / self.sample_rate
        return {
            "master_url": f"/api/audio/{filename}",
            "filename": filename,
            "duration": round(total_duration, 2)
        }

    def export_blocks_as_zip(self, blocks: List[Dict], filename: str = "story_sentences.zip") -> Dict:
        """
        Synthesizes/gathers all blocks and packages each sentence as a separate numbered WAV file in a ZIP archive.
        """
        import zipfile
        out_zip_path = OUTPUT_DIR / filename

        valid_blocks = [b for b in blocks if b.get("text", "").strip()]
        if not valid_blocks:
            return {"error": "No valid sentences to export"}

        with zipfile.ZipFile(str(out_zip_path), "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for i, b in enumerate(valid_blocks):
                text = b.get("text", "").strip()
                voice_id = b.get("voice_id", "am_fenrir")
                blend_weights = b.get("blend_weights")
                speed = float(b.get("speed", 0.90))
                gain = float(b.get("gain", 1.0))

                res = self.synthesize_block(text, voice_id, blend_weights, speed, gain)
                cache_file = CACHE_DIR / f"{res['hash']}.wav"

                # Generate clean filename: 001_sentence_slug.wav
                slug = re.sub(r'[^a-zA-Z0-9_\- ]', '', text)[:28].strip().replace(' ', '_').lower()
                arcname = f"{i+1:03d}_{slug}.wav" if slug else f"sentence_{i+1:03d}.wav"

                zf.write(str(cache_file), arcname=arcname)

        return {
            "filename": filename,
            "zip_url": f"/api/audio/{filename}",
            "file_count": len(valid_blocks)
        }
