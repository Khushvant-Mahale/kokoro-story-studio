import asyncio
import re
from pathlib import Path
import edge_tts

BASE_DIR = Path(__file__).resolve().parent
INPUT_DIR = BASE_DIR / "input"
OUTPUT_DIR = BASE_DIR / "output"

# Default voice and settings
VOICE = "en-US-ChristopherNeural"
RATE = "-6%"
PITCH = "-4Hz"

# File paths with fallback support
SCRIPT_FILE = INPUT_DIR / "THE ENDLESS ECLIPSE.txt"
if not SCRIPT_FILE.exists():
    SCRIPT_FILE = BASE_DIR / "THE ENDLESS ECLIPSE.txt"

OUTPUT_FILE = OUTPUT_DIR / "Endless_Eclipse_Full.mp3"


async def synthesize_story(script_path: Path = SCRIPT_FILE, output_path: Path = OUTPUT_FILE):
    if not script_path.exists():
        raise FileNotFoundError(f"Source text file not found: {script_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(script_path, "r", encoding="utf-8-sig") as f:
        text = f.read()

    # Split into sentences and combine into ~100-word batches
    sentences = re.split(r'(?<=[.!?])\s+', text)
    batches = []
    current_batch = []
    current_len = 0

    for s in sentences:
        s = s.strip()
        if not s:
            continue
        words = len(s.split())
        if current_len + words > 100 and current_batch:
            batches.append(" ".join(current_batch))
            current_batch = [s]
            current_len = words
        else:
            current_batch.append(s)
            current_len += words

    if current_batch:
        batches.append(" ".join(current_batch))

    print(f"Total batches to process: {len(batches)} (Takes ~2-3 mins)")

    with open(output_path, "wb") as out_f:
        for idx, batch in enumerate(batches, 1):
            print(f"[{idx}/{len(batches)}] Synthesizing batch...")
            comm = edge_tts.Communicate(batch, VOICE, rate=RATE, pitch=PITCH)
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    out_f.write(chunk["data"])

    print(f"\nNarration finished! Saved to {output_path}")


if __name__ == "__main__":
    asyncio.run(synthesize_story())
