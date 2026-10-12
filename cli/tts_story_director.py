import re
from pathlib import Path
from dataclasses import dataclass
from typing import List, Literal, Optional
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"
INPUT_DIR = BASE_DIR / "input"
OUTPUT_DIR = BASE_DIR / "output"

RoleType = Literal["narrator", "female", "female_whisper", "male_whisper", "child_whisper", "intense_dialogue", "male_dialogue"]

@dataclass
class StorySegment:
    text: str
    role: RoleType
    speed: float = 0.90
    gain: float = 1.0
    pause_after: float = 0.6  # seconds of silence after segment


class StoryDirector:
    """
    Analyzes story text and directs voice casting, dialogue tags, and emotions.
    """

    # Keyword patterns for speaker attribution
    FEMALE_CUES = re.compile(r"\b(she|her|woman|girl|mother|lady|mrs|sister|daughter)\b", re.IGNORECASE)
    MALE_CUES = re.compile(r"\b(he|him|his|man|boy|father|mr|brother|son|guy)\b", re.IGNORECASE)
    CHILD_CUES = re.compile(r"\b(child|little boy|little girl|kid|toddler)\b", re.IGNORECASE)

    # Keyword patterns for delivery style
    WHISPER_CUES = re.compile(r"\b(whisper|whispered|whispering|breathed|hissed|murmured|faintly|low voice)\b", re.IGNORECASE)
    SCREAM_CUES = re.compile(r"\b(scream|screamed|screaming|shout|shouted|shouting|yelled|cried out|panicked)\b", re.IGNORECASE)

    def __init__(self):
        model_path = MODELS_DIR / "kokoro-v0_19.onnx"
        voices_path = MODELS_DIR / "voices-v1.0.bin"
        
        print(f"Loading Kokoro engine ({model_path.name})...")
        self.kokoro = Kokoro(str(model_path), str(voices_path))
        self.sample_rate = 24000

        # Cast voice styles
        print("Casting voice profiles...")
        v_fenrir = self.kokoro.get_voice_style("am_fenrir")
        v_onyx = self.kokoro.get_voice_style("am_onyx")
        v_adam = self.kokoro.get_voice_style("am_adam")
        v_heart = self.kokoro.get_voice_style("af_heart")
        v_river = self.kokoro.get_voice_style("af_river")
        v_michael = self.kokoro.get_voice_style("am_michael")
        v_echo = self.kokoro.get_voice_style("am_echo")

        self.voice_map = {
            # Narrator: 60% Fenrir + 40% Onyx (Deep suspense baritone)
            "narrator": (0.60 * v_fenrir) + (0.40 * v_onyx),
            # Female character
            "female": v_heart,
            # Whispering styles
            "female_whisper": v_river,
            "child_whisper": v_river,
            "male_whisper": v_echo,
            # Shouting / high tension
            "intense_dialogue": v_fenrir,
            # Other male character dialogue
            "male_dialogue": v_michael,
        }

    def parse_line(self, line: str, prev_context: str = "", next_context: str = "") -> List[StorySegment]:
        """
        Parses a single paragraph into narrative and dialogue segments with contextual emotion.
        """
        line = line.strip()
        if not line:
            return []

        # If the line ends with a colon, it is a narrator lead-in (e.g. "Then she said, in a perfectly calm voice:")
        if line.endswith(":"):
            return [StorySegment(line, "narrator", speed=0.90, gain=1.0, pause_after=0.4)]

        # Check for quoted speech: "..." or “...”
        quote_pattern = re.compile(r'([\"“][^\"”]+[\"”])')
        parts = quote_pattern.split(line)

        # Check for dialogue tag introducing speech after colon or comma: e.g. "A little boy whispered, Why did you leave us outside?"
        unquoted_dialogue = re.match(r'^(.*?\b(?:whispered|whispering|screamed|cried|said|asked|shouted)[,:]\s*)([A-Z].{5,}[.?!])$', line, re.IGNORECASE)

        segments = []

        if len(parts) > 1:
            for part in parts:
                part = part.strip()
                if not part:
                    continue
                if part.startswith(('"', '“')) and part.endswith(('"', '”')):
                    clean_dialogue = part.strip('"“”')
                    context_window = prev_context + " " + line + " " + next_context
                    role, speed, gain, pause = self._classify_dialogue(clean_dialogue, context_window)
                    segments.append(StorySegment(clean_dialogue, role, speed, gain, pause))
                else:
                    segments.append(StorySegment(part, "narrator", speed=0.90, gain=1.0, pause_after=0.3))
        elif unquoted_dialogue:
            tag_part = unquoted_dialogue.group(1).strip()
            speech_part = unquoted_dialogue.group(2).strip()
            segments.append(StorySegment(tag_part, "narrator", speed=0.90, gain=1.0, pause_after=0.3))
            role, speed, gain, pause = self._classify_dialogue(speech_part, tag_part + " " + prev_context)
            segments.append(StorySegment(speech_part, role, speed, gain, pause))
        else:
            # Entire line is narration
            pause = 1.2 if (line.lower().startswith("day ") or line.lower().startswith("part ")) else 0.6
            segments.append(StorySegment(line, "narrator", speed=0.90, gain=1.0, pause_after=pause))

        return segments

    def _classify_dialogue(self, speech: str, context: str) -> tuple:
        """
        Determines the speaker role, delivery speed, gain, and pause based on context clues.
        """
        is_whisper = bool(self.WHISPER_CUES.search(context) or self.WHISPER_CUES.search(speech))
        is_scream = bool(self.SCREAM_CUES.search(context) or "!" in speech)
        is_child = bool(self.CHILD_CUES.search(context))
        is_female = bool(self.FEMALE_CUES.search(context))
        is_male = bool(self.MALE_CUES.search(context))

        if is_child and is_whisper:
            # Ghost / child whisper: softer volume (0.7), slower breathy cadence
            return "child_whisper", 0.78, 0.70, 1.2
        elif is_whisper:
            if is_female:
                return "female_whisper", 0.80, 0.75, 1.0
            return "male_whisper", 0.80, 0.75, 1.0
        elif is_scream:
            # Screamed / panicked dialogue: faster pace, higher volume
            return "intense_dialogue", 1.02, 1.15, 0.8
        elif is_female:
            # Natural female character
            return "female", 0.86, 1.0, 0.8
        elif is_male:
            # Distinct male character
            return "male_dialogue", 0.88, 1.0, 0.8
        else:
            # Default dialogue
            return "male_dialogue", 0.88, 1.0, 0.7

    def direct_and_render(self, text: str, output_file: Path) -> Path:
        """
        Processes multi-paragraph story text, casting voices dynamically, and rendering to audio.
        """
        lines = [l.strip() for l in text.split("\n") if l.strip()]
        
        # 1. Parse all segments
        all_segments: List[StorySegment] = []
        for i, line in enumerate(lines):
            prev_ctx = lines[i-1] if i > 0 else ""
            next_ctx = lines[i+1] if i < len(lines)-1 else ""
            segs = self.parse_line(line, prev_ctx, next_ctx)
            all_segments.extend(segs)

        print(f"\n[Story Director] Parsed {len(all_segments)} dynamic audio segments.")
        
        # 2. Synthesize each segment
        audio_blocks = []
        for idx, seg in enumerate(all_segments, 1):
            role_desc = f"{seg.role} (spd={seg.speed}, vol={seg.gain})"
            print(f"[{idx}/{len(all_segments)}] [{role_desc}] -> {seg.text[:40]}...")
            
            voice_style = self.voice_map[seg.role]
            raw_audio, _ = self.kokoro.create(seg.text, voice=voice_style, speed=seg.speed, lang="en-us")
            
            # Apply volume/gain
            if seg.gain != 1.0:
                raw_audio = raw_audio * seg.gain
            
            audio_blocks.append(raw_audio)
            
            # Insert pause
            if seg.pause_after > 0:
                silence = np.zeros(int(self.sample_rate * seg.pause_after), dtype=np.float32)
                audio_blocks.append(silence)

        # 3. Concatenate and write final track
        master = np.concatenate(audio_blocks)
        output_file.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(output_file), master, self.sample_rate)
        
        duration_sec = len(master) / self.sample_rate
        print(f"\n[Story Director] Master audio exported to: {output_file} ({duration_sec:.1f}s)")
        return output_file


if __name__ == "__main__":
    # Test on the opening chapter of The Endless Eclipse
    sample_path = INPUT_DIR / "THE ENDLESS ECLIPSE - Sample.txt"
    if not sample_path.exists():
        sample_path = INPUT_DIR / "THE ENDLESS ECLIPSE.txt"

    with open(sample_path, "r", encoding="utf-8-sig") as f:
        story_content = f.read()

    director = StoryDirector()
    out = OUTPUT_DIR / "endless_eclipse_directed_master.wav"
    director.direct_and_render(story_content, out)
