import json
import re
from pathlib import Path
from typing import Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parent.parent
PROJECTS_DIR = BASE_DIR / "projects"
INPUT_DIR = BASE_DIR / "input"
VOICES_FILE = BASE_DIR / "core" / "voices_metadata.json"

PROJECTS_DIR.mkdir(parents=True, exist_ok=True)


class ProjectManager:
    # Keyword patterns for speaker attribution
    FEMALE_CUES = re.compile(r"\b(she|her|woman|girl|mother|lady|mrs|sister|daughter|female)\b", re.IGNORECASE)
    MALE_CUES = re.compile(r"\b(he|him|his|man|boy|father|mr|brother|son|guy|male)\b", re.IGNORECASE)
    CHILD_CUES = re.compile(r"\b(child|little boy|little girl|kid|toddler|baby)\b", re.IGNORECASE)

    # Keyword patterns for delivery style and emotion
    WHISPER_CUES = re.compile(r"\b(whisper|whispered|whispering|breathed|hissed|murmured|faintly|low voice|softly|quietly)\b", re.IGNORECASE)
    SCREAM_CUES = re.compile(r"\b(scream|screamed|screaming|shout|shouted|shouting|yelled|yelling|cried out|panicked|shrieked|bellowed|hollered)\b", re.IGNORECASE)
    DIALOGUE_INTRO_CUES = re.compile(r"\b(whispered|screamed|said|asked|shouted|cried|murmured|replied|answered|called out|muttered)[,:]\s*$", re.IGNORECASE)

    def __init__(self):
        self._preset_blends_cache = None

    def _get_preset_blends(self) -> Dict[str, Dict[str, float]]:
        if self._preset_blends_cache is None:
            self._preset_blends_cache = {}
            if VOICES_FILE.exists():
                try:
                    with open(VOICES_FILE, "r", encoding="utf-8") as f:
                        meta = json.load(f)
                    for item in meta:
                        if item.get("is_blend") and "blend_weights" in item:
                            self._preset_blends_cache[item["id"]] = item["blend_weights"]
                except Exception:
                    pass
        return self._preset_blends_cache

    def get_project_path(self, project_id: str) -> Path:
        safe_id = re.sub(r"[^a-zA-Z0-9_\-]", "_", project_id) or "default"
        return PROJECTS_DIR / f"{safe_id}.json"

    def auto_direct_blocks(self, blocks: List[Dict], default_voice: str = "blend_fenrir_onyx", expand_dialogue: bool = True) -> List[Dict]:
        """
        Dynamically directs speech and character casting across blocks.
        Detects quotes, dialogue tags, whispers, screams/exaggerations, and pacing gaps.
        """
        if not blocks:
            return []

        preset_blends = self._get_preset_blends()
        default_is_blend = default_voice in preset_blends
        default_blend_weights = preset_blends.get(default_voice) if default_is_blend else None

        # Step 1: Optionally expand blocks that contain both dialogue tags and speech
        expanded_blocks = []
        block_counter = 1

        for b in blocks:
            text = (b.get("text") or "").strip()
            if not text:
                continue

            if text.endswith(":"):
                expanded_blocks.append({
                    "id": b.get("id") or f"b_{block_counter}",
                    "text": text,
                    "_orig": b
                })
                block_counter += 1
                continue

            # Check unquoted lead-in: "A little boy whispered, Why did you leave us outside?"
            unquoted_match = re.match(r'^(.*?\b(?:whispered|whispering|screamed|cried|said|asked|shouted|murmured)[,:]\s*)([A-Z].{3,}[.?!]?)$', text, re.IGNORECASE)
            # Check quoted dialogue tag: 'She whispered, "Don\'t move."'
            quoted_intro_match = re.match(r'^(.*?\b(?:whispered|whispering|screamed|cried|said|asked|shouted|murmured)[,:]\s*)([\"“][^\"”]+[\"”])$', text, re.IGNORECASE)
            # Check quoted speech followed by tag: '"Don\'t move," she whispered.'
            trailing_tag_match = re.match(r'^([\"“][^\"”]+[\"”])\s*([,]?\s*(?:she|he|they|the\s+\w+)?\s*(?:whispered|screamed|said|asked|shouted|murmured).*)$', text, re.IGNORECASE)

            if expand_dialogue and unquoted_match:
                tag = unquoted_match.group(1).strip()
                speech = unquoted_match.group(2).strip()
                expanded_blocks.append({"id": f"b_{block_counter}", "text": tag, "_orig": b})
                block_counter += 1
                expanded_blocks.append({"id": f"b_{block_counter}", "text": speech, "_orig": b})
                block_counter += 1
            elif expand_dialogue and quoted_intro_match:
                tag = quoted_intro_match.group(1).strip()
                speech = quoted_intro_match.group(2).strip()
                expanded_blocks.append({"id": f"b_{block_counter}", "text": tag, "_orig": b})
                block_counter += 1
                expanded_blocks.append({"id": f"b_{block_counter}", "text": speech, "_orig": b})
                block_counter += 1
            elif expand_dialogue and trailing_tag_match:
                speech = trailing_tag_match.group(1).strip()
                tag = trailing_tag_match.group(2).strip().lstrip(",").strip()
                expanded_blocks.append({"id": f"b_{block_counter}", "text": speech, "_orig": b})
                block_counter += 1
                if tag:
                    expanded_blocks.append({"id": f"b_{block_counter}", "text": tag, "_orig": b})
                    block_counter += 1
            else:
                expanded_blocks.append({
                    "id": b.get("id") or f"b_{block_counter}",
                    "text": text,
                    "_orig": b
                })
                block_counter += 1

        # Step 2: Contextual classification for all blocks
        directed_blocks = []
        n = len(expanded_blocks)

        for i, item in enumerate(expanded_blocks):
            text = item["text"]
            orig = item.get("_orig", {})
            prev_text = expanded_blocks[i - 1]["text"] if i > 0 else ""
            prev_prev_text = expanded_blocks[i - 2]["text"] if i > 1 else ""
            next_text = expanded_blocks[i + 1]["text"] if i < n - 1 else ""
            # Check quotes and dialogue nature
            is_quoted = bool(re.search(r'[\"“].+?[\"”]', text)) or (text.startswith(('"', '“', "'", '‘')) and text.endswith(('"', '”', "'", '’')))
            is_intro_lead = text.endswith(":") or bool(self.DIALOGUE_INTRO_CUES.search(text))
            prev_was_intro = prev_text.endswith(":") or bool(self.DIALOGUE_INTRO_CUES.search(prev_text))
            next_is_trailing = bool(re.match(r'^(?:she|he|they|the\s+\w+)?\s*(?:whispered|screamed|said|asked|shouted|murmured|cried|breathed)', next_text, re.IGNORECASE))

            is_dialogue = is_quoted or (prev_was_intro and not is_intro_lead)

            # Context specifically tailored for dialogue attribution
            if is_dialogue:
                ctx_parts = [text]
                if prev_was_intro:
                    ctx_parts.append(prev_text)
                    if prev_prev_text.endswith(":") or bool(self.DIALOGUE_INTRO_CUES.search(prev_prev_text)):
                        ctx_parts.append(prev_prev_text)
                if next_is_trailing:
                    ctx_parts.append(next_text)
                context = " ".join(ctx_parts)
            else:
                context = f"{prev_text} {text} {next_text}"

            # Cues detection
            is_whisper = bool(self.WHISPER_CUES.search(text) or (is_dialogue and self.WHISPER_CUES.search(context)))
            is_scream = bool(self.SCREAM_CUES.search(text) or (is_dialogue and (self.SCREAM_CUES.search(context) or "!" in text)))
            is_child = bool(self.CHILD_CUES.search(text) or (is_dialogue and self.CHILD_CUES.search(context)))
            is_female = bool(self.FEMALE_CUES.search(text) or (is_dialogue and self.FEMALE_CUES.search(context)))
            is_male = bool(self.MALE_CUES.search(text) or (is_dialogue and self.MALE_CUES.search(context)))

            # Default parameters
            voice_id = default_voice
            blend_weights = default_blend_weights if default_is_blend else None
            speed = 0.90
            gain = 1.0
            pause = 0.6

            if is_intro_lead:
                # Narrator lead-in before dialogue: short pause
                voice_id = default_voice
                blend_weights = default_blend_weights if default_is_blend else None
                speed = 0.90
                gain = 1.0
                pause = 0.4
            elif is_dialogue:
                if is_child and is_whisper:
                    voice_id = "af_river"
                    blend_weights = None
                    speed = 0.78
                    gain = 0.70
                    pause = 1.2
                elif is_whisper:
                    voice_id = "af_river" if is_female else "am_echo"
                    blend_weights = None
                    speed = 0.80
                    gain = 0.75
                    pause = 1.0
                elif is_scream:
                    # Screamed / panicked dialogue: faster pace, higher volume
                    voice_id = "af_heart" if is_female else "am_fenrir"
                    blend_weights = None
                    speed = 1.04
                    gain = 1.15
                    pause = 0.8
                elif is_female:
                    voice_id = "af_heart"
                    blend_weights = None
                    speed = 0.86
                    gain = 1.0
                    pause = 0.8
                elif is_male:
                    voice_id = "am_michael"
                    blend_weights = None
                    speed = 0.88
                    gain = 1.0
                    pause = 0.8
                else:
                    voice_id = "am_michael"
                    blend_weights = None
                    speed = 0.88
                    gain = 1.0
                    pause = 0.8
            else:
                # Narration
                clean_lower = text.lower()
                if clean_lower.startswith(("day ", "part ", "chapter ", "episode ")):
                    pause = 1.2
                elif is_whisper:
                    voice_id = "af_river" if is_female else "am_echo"
                    blend_weights = None
                    speed = 0.80
                    gain = 0.75
                    pause = 0.9
                elif is_scream:
                    voice_id = "am_fenrir"
                    blend_weights = None
                    speed = 0.96
                    gain = 1.10
                    pause = 0.7
                else:
                    voice_id = default_voice
                    blend_weights = default_blend_weights if default_is_blend else None
                    speed = 0.90
                    gain = 1.0
                    pause = 0.6

            block_data = {
                "id": item["id"],
                "text": text,
                "voice_id": voice_id,
                "speed": round(speed, 2),
                "gain": round(gain, 2),
                "pause_after": round(pause, 1)
            }
            if blend_weights:
                block_data["blend_weights"] = blend_weights

            # Check if unchanged from original cached audio
            if orig:
                if (orig.get("voice_id") == voice_id and
                    orig.get("speed") == block_data["speed"] and
                    orig.get("gain") == block_data["gain"] and
                    orig.get("pause_after") == block_data["pause_after"] and
                    orig.get("cachedAudioUrl")):
                    block_data["cachedAudioUrl"] = orig.get("cachedAudioUrl")
                    block_data["cachedSig"] = orig.get("cachedSig")
                    if orig.get("duration"):
                        block_data["duration"] = orig.get("duration")

            directed_blocks.append(block_data)

        return directed_blocks

    def split_text_into_blocks(self, raw_text: str, default_voice: str = "blend_fenrir_onyx") -> List[Dict]:
        """Splits raw story text into structured sentence blocks and dynamically directs them."""
        lines = [l.strip() for l in raw_text.replace("\r\n", "\n").split("\n") if l.strip()]
        quote_pattern = re.compile(r'([\"“][^\"”]+[\"”])')
        candidate_sentences = []

        for line in lines:
            if line.endswith(":"):
                candidate_sentences.append(line)
                continue

            parts = quote_pattern.split(line)
            if len(parts) > 1:
                for part in parts:
                    part = part.strip()
                    if not part:
                        continue
                    if part.startswith(('"', '“')) and part.endswith(('"', '”')):
                        candidate_sentences.append(part)
                    else:
                        sub_sents = [s.strip() for s in re.split(r'(?<=[.!?])\s+', part) if s.strip()]
                        candidate_sentences.extend(sub_sents if sub_sents else [part])
            else:
                sents = [s.strip() for s in re.split(r'(?<=[.!?])\s+', line) if s.strip()]
                candidate_sentences.extend(sents if sents else [line])

        initial_blocks = []
        for idx, sent in enumerate(candidate_sentences, 1):
            initial_blocks.append({
                "id": f"b_{idx}",
                "text": sent,
                "voice_id": default_voice,
                "speed": 0.90,
                "gain": 1.0,
                "pause_after": 0.6
            })

        directed = self.auto_direct_blocks(initial_blocks, default_voice=default_voice, expand_dialogue=True)
        return self.merge_ultra_small_blocks(directed)

    def merge_ultra_small_blocks(self, blocks: List[Dict], max_chars: int = 35, max_words: int = 5, max_merged_chars: int = 160) -> List[Dict]:
        """
        Merges consecutive ultra-small sentence blocks of the same narrator/voice.
        Preserves dialogue quotes, colons, chapter headers, and character boundaries.
        """
        if not blocks:
            return []

        merged = []
        i = 0
        n = len(blocks)
        counter = 1

        while i < n:
            curr = dict(blocks[i])
            curr_text = (curr.get("text") or "").strip()

            while i + 1 < n:
                nxt = blocks[i + 1]
                nxt_text = (nxt.get("text") or "").strip()

                # Voice matching
                same_voice = (curr.get("voice_id") == nxt.get("voice_id"))
                same_blend = (curr.get("blend_weights") == nxt.get("blend_weights"))
                if not (same_voice and same_blend):
                    break

                # Never merge colon intro leads
                if curr_text.endswith(":") or nxt_text.endswith(":"):
                    break

                # Never merge chapter/day headers
                if curr_text.lower().startswith(("day ", "part ", "chapter ")) or nxt_text.lower().startswith(("day ", "part ", "chapter ")):
                    break

                # Never merge quoted dialogue with unquoted narrative
                curr_has_quotes = bool(re.search(r'[\"“].+?[\"”]', curr_text)) or curr_text.startswith(('"', '“'))
                nxt_has_quotes = bool(re.search(r'[\"“].+?[\"”]', nxt_text)) or nxt_text.startswith(('"', '“'))
                if curr_has_quotes != nxt_has_quotes:
                    break

                # Check if either block is ultra-small
                curr_is_small = len(curr_text) <= max_chars or len(curr_text.split()) <= max_words
                nxt_is_small = len(nxt_text) <= max_chars or len(nxt_text.split()) <= max_words

                if not (curr_is_small or nxt_is_small):
                    break

                potential_len = len(curr_text) + 1 + len(nxt_text)
                if potential_len > max_merged_chars:
                    break

                curr_text = f"{curr_text} {nxt_text}"
                curr["text"] = curr_text
                curr["pause_after"] = nxt.get("pause_after", curr.get("pause_after", 0.6))
                curr.pop("cachedAudioUrl", None)
                curr.pop("cachedSig", None)
                curr.pop("duration", None)
                i += 1

            curr["id"] = f"b_{counter}"
            curr["text"] = curr_text
            counter += 1
            merged.append(curr)
            i += 1

        return merged

    def load_project(self, project_id: str = "default") -> Dict:
        path = self.get_project_path(project_id)
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)

        # Create default project from sample text
        sample_file = INPUT_DIR / "THE ENDLESS ECLIPSE - Sample.txt"
        if not sample_file.exists():
            sample_file = INPUT_DIR / "THE ENDLESS ECLIPSE.txt"

        if sample_file.exists():
            with open(sample_file, "r", encoding="utf-8-sig") as f:
                text = f.read()
        else:
            text = "At six fourteen in the morning, the sun failed to rise.\nAt six fifteen, the dead began calling home."

        blocks = self.split_text_into_blocks(text)
        project_data = {
            "id": project_id,
            "title": "The Endless Eclipse - Episode 1",
            "blocks": blocks,
            "master_filename": "endless_eclipse_master.wav"
        }
        self.save_project(project_data, project_id)
        return project_data

    def save_project(self, project_data: Dict, project_id: str = "default") -> None:
        path = self.get_project_path(project_id)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(project_data, f, indent=2, ensure_ascii=False)

    def list_projects(self) -> List[Dict]:
        projects = []
        for p in PROJECTS_DIR.glob("*.json"):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    mtime = p.stat().st_mtime
                    projects.append({
                        "id": data.get("id", p.stem),
                        "title": data.get("title", p.stem),
                        "block_count": len(data.get("blocks", [])),
                        "updated_at": mtime
                    })
            except Exception:
                pass
        projects.sort(key=lambda x: x["updated_at"], reverse=True)
        return projects

    def delete_project(self, project_id: str) -> bool:
        path = self.get_project_path(project_id)
        if path.exists():
            path.unlink()
            return True
        return False
