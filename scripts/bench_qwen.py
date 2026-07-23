"""Measure Qwen3-TTS 0.6B on this machine: load time, x-realtime, peak VRAM, sample rate.

Usage (4060 box):  .venv/bin/python scripts/bench_qwen.py [--variant CustomVoice|Base]
Records the numbers that gate the Qwen3 engine design (spec 2026-07-23).
"""
import argparse
import time

PARA = (
    "The gates of the old capital rose out of the morning mist, and for a moment "
    "nobody in the caravan spoke. Kaede tightened her grip on the reins. Whatever "
    "waited past those walls - the guild examiners, the debt collectors, the rumor "
    "of a dungeon breathing under the palace - it could not be worse than another "
    "winter on the road. 'We move at first light,' the captain said."
)  # ~400 chars, one real chapter-sized chunk


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", default="CustomVoice", choices=["CustomVoice", "Base"])
    ap.add_argument("--runs", type=int, default=3)
    args = ap.parse_args()

    import torch
    from qwen_tts import Qwen3TTSModel

    name = f"Qwen/Qwen3-TTS-12Hz-0.6B-{args.variant}"
    t0 = time.monotonic()
    model = Qwen3TTSModel.from_pretrained(name, device_map="cuda:0", dtype=torch.bfloat16)
    print(f"load: {time.monotonic() - t0:.1f}s  ({name})")
    print("voice-clone API:", [m for m in dir(model) if "clone" in m.lower() or "voice" in m.lower()])

    torch.cuda.reset_peak_memory_stats()
    for i in range(args.runs):
        t0 = time.monotonic()
        wavs, sr = model.generate_custom_voice(text=PARA, language="English", speaker="Ryan")
        wall = time.monotonic() - t0
        dur = len(wavs[0]) / sr
        print(f"run {i}: {dur:.1f}s audio in {wall:.1f}s = {dur / wall:.2f}x realtime (sr={sr})")
    print(f"peak VRAM: {torch.cuda.max_memory_allocated() / 2**30:.2f} GiB")


if __name__ == "__main__":
    main()
