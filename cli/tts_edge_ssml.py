import asyncio
from pathlib import Path
import edge_tts

BASE_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = BASE_DIR / "output"
OUTPUT_FILE = OUTPUT_DIR / "whisper_test.mp3"

# SSML allows direct control over whispering and emotion
SSML_TEXT = """
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">
    <voice name="en-US-GuyNeural">
        He did not knock. He simply waited.
        <mstts:express-as style="whispering">
            Why did you leave us outside?
        </mstts:express-as>
        Then the line went dead.
    </voice>
</speak>
"""


async def run_ssml_test(output_path: Path = OUTPUT_FILE):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    communicate = edge_tts.Communicate(SSML_TEXT, "en-US-GuyNeural")
    await communicate.save(str(output_path))
    print(f"SSML test completed! Audio saved to: {output_path}")


if __name__ == "__main__":
    asyncio.run(run_ssml_test())
