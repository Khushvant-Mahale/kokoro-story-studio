"""
Kokoro Audio DSP Engine
=======================
High-performance audio processing for Story Studio voice editing:
- Pitch Shift (Semitones, without altering speech duration)
- Warmth & Bass Resonance (Low Shelf Filter)
- Clarity & Air Presence (High Shelf Filter)
- Atmospheric Room Reverb (Schroeder Comb / Allpass)
- Vintage Radio / Walkie-Talkie Bandpass Transmission FX
"""

import numpy as np

try:
    import scipy.signal as signal
    HAS_SCIPY = True
except ImportError:
    signal = None
    HAS_SCIPY = False


def phase_vocoder(d: np.ndarray, rate: float, hop_length: int = 256) -> np.ndarray:
    """
    Phase vocoder time-stretch on STFT spectrogram.
    """
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


def pitch_shift(samples: np.ndarray, sr: int = 24000, semitones: float = 0.0) -> np.ndarray:
    """
    Shifts the pitch of audio samples by specified semitones without changing duration.
    Positive = Higher pitch (youth/female/tension), Negative = Deeper pitch (monster/baritone).
    """
    if abs(semitones) < 0.05 or not HAS_SCIPY or len(samples) < 512:
        return samples

    factor = 2.0 ** (float(semitones) / 12.0)
    n_fft = 1024
    hop_length = 256

    try:
        _, _, zxx = signal.stft(samples, fs=sr, nperseg=n_fft, noverlap=n_fft - hop_length)
        z_stretch = phase_vocoder(zxx, factor, hop_length=hop_length)
        _, y_stretch = signal.istft(z_stretch, fs=sr, nperseg=n_fft, noverlap=n_fft - hop_length)

        target_len = len(samples)
        if len(y_stretch) != target_len:
            y_shift = signal.resample(y_stretch, target_len)
        else:
            y_shift = y_stretch

        return np.clip(y_shift, -1.0, 1.0).astype(np.float32)
    except Exception as e:
        print(f"[AudioDSP] Pitch shift error: {e}, returning original samples")
        return samples


def apply_eq(samples: np.ndarray, sr: int = 24000, warmth_db: float = 0.0, clarity_db: float = 0.0) -> np.ndarray:
    """
    Applies 2-band tone shaping:
    - warmth_db: 220Hz Low-shelf filter (+ for chest warmth/cinematic bass, - for thin voice)
    - clarity_db: 4500Hz High-shelf filter (+ for crisp presence/whisper, - for muffled/dark)
    """
    if (abs(warmth_db) < 0.1 and abs(clarity_db) < 0.1) or not HAS_SCIPY or len(samples) < 64:
        return samples

    out = samples.copy()

    # 1. Low shelf at 220Hz (Warmth / Chest resonance)
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

        b = np.array([b0, b1, b2]) / a0
        a = np.array([a0, a1, a2]) / a0
        out = signal.lfilter(b, a, out)

    # 2. High shelf at 4500Hz (Clarity / Crisp Air)
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

        b = np.array([b0, b1, b2]) / a0
        a = np.array([a0, a1, a2]) / a0
        out = signal.lfilter(b, a, out)

    return np.clip(out, -1.0, 1.0).astype(np.float32)


def apply_reverb(samples: np.ndarray, sr: int = 24000, wet: float = 0.0) -> np.ndarray:
    """
    Applies natural atmospheric space / room reverberation using Schroeder comb + allpass network.
    wet: 0.0 (Dry) to 0.5 (Cavern / Large Hall)
    """
    if wet <= 0.02 or not HAS_SCIPY or len(samples) < 1000:
        return samples

    wet = min(float(wet), 0.50)
    comb_delays = [int(sr * d) for d in [0.0297, 0.0371, 0.0411, 0.0437]]
    comb_gains = [0.75, 0.73, 0.71, 0.69]

    accum = np.zeros_like(samples)
    for d, g in zip(comb_delays, comb_gains):
        b = np.zeros(d + 1)
        b[0] = 1.0
        a = np.zeros(d + 1)
        a[0] = 1.0
        a[d] = -g
        filtered = signal.lfilter(b, a, samples)
        accum += filtered

    comb_out = accum / len(comb_delays)

    ap_delay = int(sr * 0.005)
    ap_b = np.zeros(ap_delay + 1)
    ap_b[0] = -0.7
    ap_b[ap_delay] = 1.0
    ap_a = np.zeros(ap_delay + 1)
    ap_a[0] = 1.0
    ap_a[ap_delay] = -0.7

    wet_signal = signal.lfilter(ap_b, ap_a, comb_out)
    mixed = (1.0 - wet) * samples + (wet * 1.2) * wet_signal
    return np.clip(mixed, -1.0, 1.0).astype(np.float32)


def apply_radio_filter(samples: np.ndarray, sr: int = 24000) -> np.ndarray:
    """
    Applies walkie-talkie / vintage emergency radio transceiver bandpass effect
    (400Hz - 3400Hz bandpass with harmonic saturation).
    """
    if not HAS_SCIPY or len(samples) < 64:
        return samples

    nyq = sr / 2.0
    low = 400.0 / nyq
    high = 3400.0 / nyq

    b, a = signal.butter(4, [low, high], btype="band")
    filtered = signal.lfilter(b, a, samples)
    # Warm soft-saturation
    saturated = np.tanh(filtered * 1.6) * 0.85
    return np.clip(saturated, -1.0, 1.0).astype(np.float32)


def process_audio_fx(
    samples: np.ndarray,
    sr: int = 24000,
    pitch_shift_st: float = 0.0,
    warmth_db: float = 0.0,
    clarity_db: float = 0.0,
    reverb_wet: float = 0.0,
    radio_fx: bool = False
) -> np.ndarray:
    """
    Master audio DSP pipeline:
    1. Pitch shift (semitones)
    2. Tone EQ (warmth + clarity)
    3. Radio Transceiver filter (if enabled)
    4. Atmosphere Reverb (if enabled)
    """
    if samples is None or len(samples) == 0:
        return samples

    out = samples.copy()

    # 1. Pitch Shift
    if abs(pitch_shift_st) >= 0.05:
        out = pitch_shift(out, sr=sr, semitones=pitch_shift_st)

    # 2. Tone EQ
    if abs(warmth_db) >= 0.1 or abs(clarity_db) >= 0.1:
        out = apply_eq(out, sr=sr, warmth_db=warmth_db, clarity_db=clarity_db)

    # 3. Radio Filter
    if radio_fx:
        out = apply_radio_filter(out, sr=sr)

    # 4. Atmosphere Reverb
    if reverb_wet > 0.02:
        out = apply_reverb(out, sr=sr, wet=reverb_wet)

    return np.clip(out, -1.0, 1.0).astype(np.float32)
