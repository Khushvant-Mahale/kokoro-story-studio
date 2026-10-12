import urllib.request
from pathlib import Path
import sys

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

MODEL_URLS = {
    "kokoro-v0_19.onnx": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v0_19.onnx",
    "voices-v1.0.bin": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
}

def download_progress(count, block_size, total_size):
    percent = int(count * block_size * 100 / total_size) if total_size > 0 else 0
    sys.stdout.write(f"\r  Progress: {percent}% [{'#' * (percent // 5)}{'.' * (20 - percent // 5)}]")
    sys.stdout.flush()

def ensure_models():
    print("=" * 60)
    print("  Kokoro Neural Model & Voice Verification")
    print("=" * 60)

    for filename, url in MODEL_URLS.items():
        target = MODELS_DIR / filename
        if target.exists() and target.stat().st_size > 1000000:
            size_mb = target.stat().st_size / (1024 * 1024)
            print(f"  [OK] {filename} is ready ({size_mb:.1f} MB)")
        else:
            print(f"\n  [Downloading] {filename} from official release...")
            urllib.request.urlretrieve(url, str(target), reporthook=download_progress)
            print(f"\n  [Downloaded] {filename} successfully.")

    print("\n  All neural models verified on disk.\n")

if __name__ == "__main__":
    ensure_models()
