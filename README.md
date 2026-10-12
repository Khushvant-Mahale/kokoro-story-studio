# 🎙️ Kokoro Story Studio

> **An advanced, dynamic multi-voice audio drama & audiobook production studio powered by the Kokoro v0.19 Neural Engine with local CPU and zero-cost Cloud GPU acceleration.**

![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)
![Kokoro ONNX](https://img.shields.io/badge/engine-Kokoro--v0.19--ONNX-purple.svg)
![Acoustics](https://img.shields.io/badge/audio-24kHz--High--Fidelity-emerald.svg)
![Cloud GPU](https://img.shields.io/badge/gpu-Google%20Colab%20T4-orange.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

---

## 🌟 Overview

**Kokoro Story Studio** transforms written narratives into cinematic audio dramas. Featuring real-time voice blending, context-aware character attribution, whisper & scream emotion directing, and zero-setup Google Colab T4 GPU acceleration, it provides a studio-grade interface for authors, voice artists, and audio drama creators.

---

## ✨ Key Features

### 🎭 1. Intelligent StoryDirector Auto-Casting
* **Context-Aware Character Casting**: Automatically detects dialogue quotes (`"..."`, `“...”`) and speaker gender attribution (`she`, `her`, `woman` vs `he`, `him`, `man`, `father`).
* **Ghostly & Soft Whispers**: Recognizes emotional whisper cues (`whispered`, `murmured`, `breathed`, `low voice`) and dynamically assigns:
  * **Child/Female Whisper** (`af_river`): **0.78x speed**, **70% volume**, **1.2s trailing pause**.
  * **Male Whisper** (`am_echo`): **0.80x speed**, **75% volume**, **1.0s trailing pause**.
* **Intense Screams & Panicked Tension**: Detects shouting tags (`screamed`, `yelled`, `panicked`) or exclamations (`!`) and assigns:
  * **Intense Delivery** (`am_fenrir`): **1.04x speed**, **115% exaggerated volume gain**, **0.8s pause**.
* **Dialogue Lead-ins with Colons**: Lines ending with `:` (e.g. `Then she said, in a perfectly calm voice:`) are automatically assigned a tight **0.4s breath pause**, priming the immediate dialogue quote.
* **Chapter / Day Breaks**: Identifies `Day 1`, `Part 2`, or `Chapter 3` and injects dramatic **1.2s scene transition gaps**.

---

### 🔗 2. Smart Sentence Combiner
* **`🔗 Merge Short Blocks`**: 1-click automatic combiner that scans the whole narrative and merges ultra-short consecutive fragments of the same narrator (e.g. *"No network."*, *"No emergency lines."*, *"It rang."*, *"I dropped it."*) into natural, flowing sentence blocks.
  * **Safety Guards**: Never merges across different character voices, never merges colon lead-ins into dialogue, and preserves chapter boundaries.
* **`🔗 Merge Selected`**: Select any 2 or more sentences with custom checkboxes and merge them instantly into a single block.

---

### 🎛️ 3. 1-Click Character & Delivery Presets
Select one or multiple sentences (or click **Select All**) and apply professional acoustic profiles with 1 click from the Left Inspector:
* **🎙️ Narrator**: Reverts to default project narrator (`0.90x pace`, `100% vol`, `0.6s pause`).
* **🤫 Soft Whisper**: Sets breathy intimate delivery (`af_river`, `0.80x pace`, `75% vol`, `1.0s pause`).
* **😱 Intense Scream**: Sets high-tension panicked delivery (`am_fenrir`, `1.04x pace`, `115% vol`, `0.8s pause`).
* **👩 Female Dialogue**: Sets natural emotional female character (`af_heart`, `0.86x pace`, `100% vol`, `0.8s pause`).
* **👨 Male Dialogue**: Sets authoritative male character (`am_michael`, `0.88x pace`, `100% vol`, `0.8s pause`).

---

### ⚡ 4. Interactive Audio Scrubber & Word-Level Seek
* **Visual Sentence Scrubbers**: Every sentence block features an interactive audio waveform track.
* **Word-Level Seeking**: Click anywhere within a sentence to listen from that exact point.
* **Double-Click Word to Play**: Double-click any word in the text editor to start instant playback from that word.
* **Transport Timeline**: Bottom master timeline with Play/Pause (Space), Next/Prev, Stop, and live timecode.

---

### 🚀 5. Zero-Setup Cloud GPU Acceleration (Free Colab T4)
* Run inference at **5x to 10x real-time speed** using a free Google Colab Tesla T4 GPU!
* **1-Cell Execution**: Run `colab_worker.py` on Colab — it downloads model weights, boots an ONNX CUDA session, and creates an end-to-end encrypted HTTPS tunnel via `pycloudflared`.
* **Instant Fallback**: If Colab disconnects, the studio seamlessly falls back to the local CPU engine without dropping renders.

---

### 📦 6. Multi-Format Master Exports
* **🎬 Master WAV Export**: Automatically stitches all rendered sentence audio blocks into a seamless 24kHz master WAV file with custom inter-sentence pauses.
* **📦 Individual Sentence ZIP Export**: Exports every sentence as a clean, sequentially numbered WAV file (`001_b1.wav`, `002_b2.wav`, ...) inside a structured ZIP archive.

---

## ⚡ Quick Run Pipeline

### Option A: Windows 1-Click Runner
Double-click or run:
```cmd
run.bat
```
*(Checks Python, installs requirements, verifies neural models, launches the server, and opens your browser.)*

---

### Option B: Linux / macOS 1-Click Runner
Make executable and run:
```bash
chmod +x run.sh
./run.sh
```

---

### Option C: Manual Setup
1. **Clone the repository**:
   ```bash
   git clone https://github.com/Khushvant-Mahale/kokoro-story-studio.git
   cd kokoro-story-studio
   ```

2. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

3. **Verify/download Kokoro neural weights**:
   ```bash
   python download_models.py
   ```

4. **Launch Kokoro Story Studio**:
   ```bash
   python app.py --port 7860
   ```
   Open **`http://localhost:7860`** in your browser!

---

## ☁️ Google Colab Cloud GPU Setup Guide

To enable blazing-fast GPU synthesis (0.2s per sentence):

1. Open a new notebook at [Google Colab](https://colab.research.google.com/).
2. In the Colab menu, select **Runtime → Change runtime type** and choose **T4 GPU**.
3. In Kokoro Studio, click the **🚀 Cloud GPU** badge in the top bar, then click **📋 Copy Colab Script**.
4. Paste the code into a cell in Colab and click **Run**.
5. Once running, copy the generated HTTPS URL:
   ```text
   * Running on https://your-tunnel-name.trycloudflare.com
   ```
6. In Kokoro Studio, paste this URL into the Cloud GPU modal and click **Save & Activate**.

---

## 📁 Repository Structure

```text
kokoro-story-studio/
├── app.py                     # Main Aiohttp Web Studio backend & API router
├── colab_worker.py            # Fast Cloudflare/GPU worker for Google Colab
├── download_models.py         # Automated neural model and voice downloader
├── run.bat                    # 1-Click Windows execution pipeline
├── run.sh                     # 1-Click Linux/macOS execution pipeline
├── requirements.txt           # Python package requirements
├── core/
│   ├── kokoro_engine.py       # Local ONNX & remote GPU synthesis engine
│   ├── project_manager.py     # StoryDirector, sentence splitting & merge logic
│   └── voices_metadata.json   # 20+ curated voices & custom thriller blends
├── studio/
│   ├── index.html             # Sleek dark studio interface
│   ├── css/
│   │   └── studio.css         # Modern studio styling & custom scrollbars
│   ├── js/
│   │   └── app.js             # Studio transport, batch render & inspector logic
│   └── favicon.svg            # Custom SVG studio brand mark
├── cli/
│   ├── tts_story_director.py  # Standalone CLI StoryDirector script
│   ├── tts_kokoro.py          # Standalone CLI Kokoro script
│   └── tts_edge.py            # Edge TTS reference script
├── input/
│   ├── THE ENDLESS ECLIPSE.txt        # Full sample story (71 KB)
│   └── THE ENDLESS ECLIPSE - Sample.txt # Quick chapter test excerpt
├── projects/                  # Saved user story projects (.json)
└── output/
    └── samples/               # Voice preview sample audios
```

---

## 🛠️ REST API Reference

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/voices` | `GET` | Returns list of available voices & custom blends |
| `/api/synthesize_block` | `POST` | Synthesizes a single sentence block (local CPU or remote GPU) |
| `/api/auto_direct` | `POST` | Auto-detects characters, whispers, screams & emotional pacing |
| `/api/merge_short` | `POST` | Merges consecutive ultra-short fragments of the same voice |
| `/api/split_text` | `POST` | Splits story text into directed sentences |
| `/api/export_master` | `POST` | Compiles full story into stitched master WAV |
| `/api/export_zip` | `POST` | Packages individual sentence audio files into a ZIP archive |
| `/api/config` | `GET/POST`| Manages remote Cloud GPU worker connection |
| `/api/test_remote` | `POST` | Tests connection to remote Colab tunnel |

---

## 📄 License

This project is open-source and released under the **MIT License**.
* Kokoro ONNX model is created by [@hexgrad](https://huggingface.co/hexgrad/Kokoro-82M).
* Kokoro ONNX runtime by [@thewh1teagle](https://github.com/thewh1teagle/kokoro-onnx).
