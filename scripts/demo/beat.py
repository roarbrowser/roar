#!/usr/bin/env python3
"""TEMP guide beat, synthesized locally (no samples, no third-party audio).

Usage: beat.py <style: trap|funk> <bpm> <key root, e.g. A> <seconds> <out.wav> [hit seconds, comma-separated]
Only for timing the cut; the final track must be licensed or commissioned (docs/launch/demo.md).
"""
import sys, wave
import numpy as np

SR = 44100
NOTES = {n: i for i, n in enumerate("C C# D D# E F F# G G# A A# B".split())}


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def env(n, a=0.005, d=0.2):
    t = np.arange(n) / SR
    return np.minimum(1, t / a) * np.exp(-t / d)


def kick(n, f0=150, f1=45, d=0.35):
    t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t * 30)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, 0.001, d)


def noise(n, d, rng, hp=True):
    x = rng.standard_normal(n)
    if hp:
        x = np.diff(x, prepend=0)
    return x * env(n, 0.001, d)


def tone(f, n, kind="saw", d=0.4):
    t = np.arange(n) / SR
    if kind == "sine":
        w = np.sin(2 * np.pi * f * t)
    elif kind == "square":
        w = np.sign(np.sin(2 * np.pi * f * t)) * 0.6
    else:
        w = 2 * ((f * t) % 1) - 1
    return w * env(n, 0.01, d)


def lowpass(x, a):
    y = np.empty_like(x); s = 0.0
    for i, v in enumerate(x):  # one-pole; fine for short temp tracks
        s += a * (v - s); y[i] = s
    return y


def add(buf, x, at):
    i = int(at * SR)
    if i >= len(buf):
        return
    x = x[: len(buf) - i]
    buf[i : i + len(x)] += x


def render(style, bpm, root, secs, hits):
    rng = np.random.default_rng(7)
    out = np.zeros(int(secs * SR) + SR)
    beat = 60 / bpm
    bars = int(secs / (4 * beat)) + 1
    r = NOTES[root] + 36  # bass octave
    if style == "trap":
        prog = [0, -4, -2, -5]  # i - VI - VII - v (minor)
        third = 3
    else:
        prog = [0, 5, 9, 7]  # I - IV - vi - V (major)
        third = 4
    for b in range(bars):
        t0 = b * 4 * beat
        deg = prog[b % 4]
        chord = [r + 24 + deg, r + 24 + deg + (third if deg in (0, 5, 7) or style == "funk" else 3), r + 24 + deg + 7]
        if style == "trap":
            for k in (0, 2.5, 3.25 if b % 2 else None):
                if k is not None:
                    add(out, 0.9 * kick(int(0.6 * SR), 110, 40, 0.5), t0 + k * beat)
                    add(out, 0.5 * tone(hz(r + deg), int(1.2 * beat * SR), "sine", 0.9), t0 + k * beat)
            for s in (1, 3):
                add(out, 0.35 * noise(int(0.3 * SR), 0.12, rng), t0 + s * beat)
            steps = 16 if b % 4 != 3 else 24  # hat roll every 4th bar
            for h in range(steps):
                add(out, 0.08 * noise(int(0.05 * SR), 0.02, rng), t0 + h * 4 * beat / steps)
            pad = sum(tone(hz(n), int(4 * beat * SR), "saw", 3.0) for n in chord)
            add(out, 0.05 * lowpass(pad, 0.04), t0)
        else:
            for k in (0, 1.5, 2, 3.5):
                add(out, 0.8 * kick(int(0.3 * SR), 160, 55, 0.18), t0 + k * beat)
            for s in (1, 3):
                add(out, 0.3 * noise(int(0.25 * SR), 0.08, rng) + 0.15 * noise(int(0.25 * SR), 0.05, rng, False), t0 + s * beat)
            for h in range(8):
                add(out, (0.07 if h % 2 else 0.04) * noise(int(0.04 * SR), 0.015, rng), t0 + h * beat / 2)
            line = [0, 0, 12, 7, 0, 10, 12, 7]  # syncopated funk bass
            for i, iv in enumerate(line):
                add(out, 0.3 * lowpass(tone(hz(r + 12 + deg + iv), int(0.4 * beat * SR), "square", 0.15), 0.15), t0 + i * beat / 2)
            for s in (0.5, 1.5, 2.5, 3.5):  # offbeat stabs
                stab = sum(tone(hz(n), int(0.3 * beat * SR), "saw", 0.08) for n in chord)
                add(out, 0.06 * stab, t0 + s * beat)
    for h in hits:  # riser into each hit, then an impact
        rn = int(1.5 * SR)
        riser = rng.standard_normal(rn) * np.linspace(0, 1, rn) ** 2
        add(out, 0.12 * np.diff(riser, prepend=0), h - 1.5)
        add(out, 1.0 * kick(int(1.5 * SR), 90, 30, 0.9) + 0.25 * noise(int(1.5 * SR), 0.6, rng, False), h)
    out = out[: int(secs * SR)]
    fade = int(1.5 * SR)
    out[-fade:] *= np.linspace(1, 0, fade)
    out = np.tanh(1.4 * out / max(1e-9, np.abs(out).max()))  # glue + headroom
    return out / np.abs(out).max() * 0.89


if __name__ == "__main__":
    style, bpm, root, secs, path = sys.argv[1], float(sys.argv[2]), sys.argv[3], float(sys.argv[4]), sys.argv[5]
    hits = [float(x) for x in sys.argv[6].split(",") if x] if len(sys.argv) > 6 else []
    assert style in ("trap", "funk") and root in NOTES, "style trap|funk, root like A or C#"
    x = render(style, bpm, root, secs, hits)
    assert len(x) == int(secs * SR) and np.isfinite(x).all()
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype("<i2").tobytes())
