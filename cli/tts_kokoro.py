import os
import re
from pathlib import Path
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"
INPUT_DIR = BASE_DIR / "input"
OUTPUT_DIR = BASE_DIR / "output"

# Path resolution with fallbacks
MODEL_PATH = MODELS_DIR / "kokoro-v0_19.onnx"
if not MODEL_PATH.exists():
    MODEL_PATH = BASE_DIR / "kokoro-v0_19.onnx"

VOICES_PATH = MODELS_DIR / "voices-v1.0.bin"
if not VOICES_PATH.exists():
    VOICES_PATH = BASE_DIR / "voices-v1.0.bin"

SCRIPT_FILE = INPUT_DIR / "THE ENDLESS ECLIPSE - Sample.txt"
if not SCRIPT_FILE.exists():
    SCRIPT_FILE = INPUT_DIR / "THE ENDLESS ECLIPSE - Copy.txt"
if not SCRIPT_FILE.exists():
    SCRIPT_FILE = BASE_DIR / "THE ENDLESS ECLIPSE - Copy.txt"

OUTPUT_FILE = OUTPUT_DIR / "The_Endless_Eclipse_Master.wav"


def normalize_text(raw_text: str) -> str:
    """Clean text, expand timestamps, replace placeholders and normalize punctuation."""
    clean = raw_text.replace(r"\[Name\]", "Mark").replace("[Name]", "Mark")
    clean = re.sub(r"0?6:14\s*(AM|A\.M\.)?", "six fourteen A.M.", clean, flags=re.IGNORECASE)
    clean = re.sub(r"0?6:15\s*(AM|A\.M\.)?", "six fifteen A.M.", clean, flags=re.IGNORECASE)
    clean = re.sub(r"0?6:13\s*(AM|A\.M\.)?", "six thirteen A.M.", clean, flags=re.IGNORECASE)
    clean = re.sub(r"11:32\s*(AM|A\.M\.)?", "eleven thirty-two A.M.", clean, flags=re.IGNORECASE)
    clean = re.sub(r"02:17\s*(AM|A\.M\.)?", "two seventeen A.M.", clean, flags=re.IGNORECASE)
    clean = re.sub(r"18:40", "six forty in the evening", clean)
    clean = clean.replace("—", ", ").replace("–", ", ")
    clean = clean.replace('"', '').replace("'", "'")
    return clean


def synthesize(
    script_path: Path = SCRIPT_FILE,
    output_path: Path = OUTPUT_FILE,
    speed: float = 0.90,
    sample_rate: int = 24000
):
    if not MODEL_PATH.exists():
        raise FileNotFoundError(f"Model file not found: {MODEL_PATH}")
    if not VOICES_PATH.exists():
        raise FileNotFoundError(f"Voices file not found: {VOICES_PATH}")
    if not script_path.exists():
        raise FileNotFoundError(f"Script file not found: {script_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"Loading Kokoro model from {MODEL_PATH.name}...")
    kokoro = Kokoro(str(MODEL_PATH), str(VOICES_PATH))

    # Blend voices: 65% Adam (natural pacing) + 35% Onyx (deep tone)
    v_adam = kokoro.get_voice_style("am_adam")
    v_onyx = kokoro.get_voice_style("am_onyx")
    narrator_voice = (0.65 * v_adam) + (0.35 * v_onyx)

    with open(script_path, "r", encoding="utf-8-sig") as f:
        raw_text = f.read()

    clean_text = normalize_text(raw_text)

    # Chunk into natural paragraphs
    raw_lines = clean_text.split("\n")
    paragraphs = []
    for line in raw_lines:
        line = line.strip()
        if not line or line.startswith("#") or "A 30-Day Survival" in line or "THE ENDLESS ECLIPSE" in line:
            continue
        paragraphs.append(line)

    print(f"Total paragraphs to synthesize: {len(paragraphs)}")

    # Audio gap pacing
    pause_normal = np.zeros(int(sample_rate * 0.7), dtype=np.float32)  # 0.7s breath gap
    pause_chapter = np.zeros(int(sample_rate * 1.5), dtype=np.float32) # 1.5s scene transition

    audio_segments = []

    for idx, p in enumerate(paragraphs, 1):
        print(f"[{idx}/{len(paragraphs)}] Synthesizing: {p[:45]}...")
        samples, _ = kokoro.create(
            p,
            voice=narrator_voice,
            speed=speed,
            lang="en-us"
        )
        audio_segments.append(samples)

        # Insert longer silence before major Day breaks
        if p.lower().startswith("day ") or p.lower().startswith("part "):
            audio_segments.append(pause_chapter)
        else:
            audio_segments.append(pause_normal)

    # Save final audio track
    final_track = np.concatenate(audio_segments[:-1])
    sf.write(str(output_path), final_track, sample_rate)

    duration_min = len(final_track) / sample_rate / 60
    print(f"\nDone! Master audio saved to {output_path} ({duration_min:.1f} minutes long)")


if __name__ == "__main__":
    synthesize()
