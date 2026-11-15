#!/usr/bin/env python3
"""Full-duplex voice front end for Claude Code, running locally on Apple Silicon.

    mic -> Kyutai STT (MLX, semantic end-of-turn) -> Claude Code (Agent SDK)
        -> Kyutai TTS (MLX, streaming) -> speakers

You can talk over Claude at any time: it stops speaking, the current Claude Code
turn is interrupted, and what you said becomes the next message. Tool calls that
need permission are read out and approved or denied by voice.

All MLX work (STT + TTS) runs on one compute thread so the two models interleave
cleanly at Mimi's 12.5 Hz frame rate; Claude Code runs on the asyncio side.
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import difflib
import json
import os
import queue
import re
import shutil
import sys
import threading
import time
import typing as tp
from dataclasses import dataclass, field
from urllib.parse import urlparse

import mlx.core as mx
import mlx.nn as nn
import numpy as np
import rustymimi
import sentencepiece
import sounddevice as sd
import sphn
from huggingface_hub import hf_hub_download
from moshi_mlx import models, utils
from moshi_mlx.models.generate import LmGen
from moshi_mlx.models.tts import (
    DEFAULT_DSM_TTS_REPO,
    DEFAULT_DSM_TTS_VOICE_REPO,
    TTSModel,
    script_to_entries,
)
from moshi_mlx.modules.conditioner import ConditionTensor, dropout_all_conditions
from moshi_mlx.utils.sampling import Sampler

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
)
from claude_agent_sdk.types import (
    PermissionResultAllow,
    PermissionResultDeny,
    StreamEvent,
    ToolPermissionContext,
)

SAMPLE_RATE = 24000
FRAME = 1920  # 80 ms at 24 kHz, one Mimi frame
FRAME_S = FRAME / SAMPLE_RATE

DEFAULT_STT_REPO = "kyutai/stt-1b-en_fr-candle"  # the candle weights carry the VAD heads
DEFAULT_VOICE = "expresso/ex03-ex01_happy_001_channel1_334s.wav"

STOP_WORDS = {"stop", "wait", "pause", "cancel", "quiet", "enough", "hold"}
YES_WORDS = {"yes", "yeah", "yep", "yup", "sure", "ok", "okay", "allow", "approve",
             "approved", "go", "do", "fine", "affirmative", "please", "correct"}
NO_WORDS = {"no", "nope", "don't", "dont", "deny", "denied", "stop", "cancel", "not", "never"}

VOICE_PROMPT = """\
# Voice mode
You are being used through a real-time, full-duplex voice interface running on the user's Mac.
- The user's messages come from a streaming speech-to-text model. Expect transcription errors, \
homophones, missing punctuation and mangled file or symbol names; infer what they meant, and ask \
a short clarifying question only when you genuinely can't.
- Every word of plain text you write is read aloud by a text-to-speech model as you write it. \
So talk like a person on a call: short, natural sentences. No markdown, no headings, no bullet \
lists (say a list as one sentence), no tables, no emoji, no code blocks in your replies. This \
overrides any formatting guidance elsewhere in your instructions. Never read code, diffs, long paths, \
URLs or command output aloud; summarize them instead ("I changed the retry loop in the client file").
- Do the actual work with your tools as usual. Before starting something that will take a while, \
say one short sentence about what you're about to do. When you finish, say briefly what you did \
and what you found.
- Keep answers to a few sentences unless the user asks for more detail. If you need a decision, \
ask one short question.
- The user can interrupt you mid-sentence. If they do, their next message is what they said; \
go with it.
"""


def log(msg: str) -> None:
    print(f"\033[2m{msg}\033[0m", flush=True)


def norm_word(w: str) -> str:
    return re.sub(r"[^a-z0-9']", "", w.lower())


# --------------------------------------------------------------------------- STT


class Stt:
    """Streaming Kyutai STT with the semantic end-of-turn head."""

    MAX_STEPS = 4096

    def __init__(self, hf_repo: str):
        cfg_path = hf_hub_download(hf_repo, "config.json")
        with open(cfg_path) as f:
            raw = json.load(f)
        mimi_weights = hf_hub_download(hf_repo, raw["mimi_name"])
        weights = hf_hub_download(hf_repo, raw.get("moshi_name", "model.safetensors"))
        tokenizer = hf_hub_download(hf_repo, raw["tokenizer_name"])

        lm_config = models.LmConfig.from_config_dict(raw)
        self.model = models.Lm(lm_config)
        self.model.set_dtype(mx.bfloat16)
        if hf_repo.endswith("-candle"):
            self.model.load_pytorch_weights(weights, lm_config, strict=True)
        else:
            self.model.load_weights(weights, strict=True)
        self.tokenizer = sentencepiece.SentencePieceProcessor(tokenizer)  # type: ignore
        self.other_codebooks = lm_config.other_codebooks
        n_cb = max(lm_config.generated_codebooks, lm_config.other_codebooks)
        self.mimi = rustymimi.Tokenizer(mimi_weights, num_codebooks=n_cb)  # type: ignore
        self.model.warmup()
        self.has_vad = len(self.model.extra_heads) > 2
        self.reset()

    def reset(self) -> None:
        for c in self.model.transformer_cache:
            c.reset()
        self.gen = LmGen(
            model=self.model,
            max_steps=self.MAX_STEPS,
            text_sampler=utils.Sampler(top_k=25, temp=0),
            audio_sampler=utils.Sampler(top_k=250, temp=0.8),
            check=False,
        )

    @property
    def steps(self) -> int:
        return self.gen.step_idx

    def encode(self, pcm: np.ndarray) -> np.ndarray:
        """Mimi-encodes one 80 ms frame on the CPU (rustymimi); safe to call off the GPU thread."""
        return self.mimi.encode_step(pcm[None, None, :].astype(np.float32))

    def step(self, codes: np.ndarray) -> tuple[str | None, float]:
        """Feeds one encoded frame. Returns (text piece or None, end-of-turn probability)."""
        if self.gen.step_idx >= self.MAX_STEPS - 1:
            self.reset()
        tokens = mx.array(codes).transpose(0, 2, 1)[:, :, : self.other_codebooks]
        if self.has_vad:
            text_token, heads = self.gen.step_with_extra_heads(tokens[0])
            pr_eot = heads[2][0, 0, 0].item()
        else:
            text_token = self.gen.step(tokens[0])
            pr_eot = 0.0
        tok = text_token[0].item()
        if tok in (0, 3):
            return None, pr_eot
        return self.tokenizer.id_to_piece(tok), pr_eot  # type: ignore


# --------------------------------------------------------------------------- TTS


class Tts:
    """Kyutai TTS on MLX, loaded once; `Utterance` streams one segment of speech."""

    def __init__(self, hf_repo: str, voice_repo: str, voice: str, quantize: int | None,
                 cfg_coef: float):
        def get(name: str) -> str:
            return hf_hub_download(hf_repo, name)

        with open(get("config.json")) as f:
            raw = json.load(f)
        lm_config = models.LmConfig.from_config_dict(raw)
        # moshi_mlx <= 0.3.0 has a ring kv-cache bug for this model, see Kyutai's tts_mlx.py.
        lm_config.transformer.max_seq_len = lm_config.transformer.context
        lm = models.Lm(lm_config)
        lm.set_dtype(mx.bfloat16)
        lm.load_pytorch_weights(get(raw.get("moshi_name", "model.safetensors")), lm_config,
                                strict=True)
        if quantize:
            nn.quantize(lm.depformer, bits=quantize)
            for layer in lm.transformer.layers:
                nn.quantize(layer.self_attn, bits=quantize)
                nn.quantize(layer.gating, bits=quantize)
        tokenizer = sentencepiece.SentencePieceProcessor(get(raw["tokenizer_name"]))  # type: ignore
        mimi = models.mimi.Mimi(models.mimi_202407(lm_config.generated_codebooks))
        mimi.load_pytorch_weights(get(raw["mimi_name"]), strict=True)

        self.model = TTSModel(lm, mimi, tokenizer, voice_repo=voice_repo, temp=0.6,
                              cfg_coef=cfg_coef, max_padding=8, initial_padding=2,
                              final_padding=2, padding_bonus=0, raw_config=raw)
        cfg_conditioning = None
        if self.model.valid_cfg_conditionings:
            # Distilled CFG: passed as a conditioning, no extra batch needed.
            cfg_conditioning = self.model.cfg_coef
            self.model.cfg_coef = 1.0
        voices = [self.model.get_voice_path(voice)] if self.model.multi_speaker else []
        self.attributes = [self.model.make_condition_attributes(voices, cfg_conditioning)]
        if self.model.cfg_coef != 1.0:
            self.attributes += dropout_all_conditions(self.attributes)
        mimi.warmup()

    def utterance(self) -> "Utterance":
        for c in self.model.lm.transformer_cache:
            c.reset()
        self.model.mimi.reset_all()
        return Utterance(self)


class Utterance:
    """One streamed TTS segment; words are appended as Claude produces them."""

    def __init__(self, tts: Tts):
        m = tts.model
        self.m = m
        self.offset = 0
        self.first = True
        self.final = False
        self.tail_steps: int | None = None
        self.state = m.machine.new_state([])
        self.ct = None
        self.ca_src = None
        lm = m.lm
        assert lm.condition_provider is not None
        for attr in tts.attributes:
            for key, value in attr.text.items():
                ct = lm.condition_provider.condition_tensor(key, value)
                self.ct = ct if self.ct is None else ConditionTensor(self.ct.tensor + ct.tensor)
            for key, value in attr.tensor.items():
                self.ca_src = lm.condition_provider.conditioners[key].condition(value)

        def on_audio_hook(audio_tokens):
            for q in range(audio_tokens.shape[0]):
                if self.offset < lm.delays[q] + m.delay_steps:
                    audio_tokens[q] = m.machine.token_ids.zero

        def on_text_hook(text_tokens):
            out = [m.machine.process(self.offset, self.state, t)[0] for t in text_tokens.tolist()]
            text_tokens[:] = mx.array(out, dtype=mx.int64)

        self.gen = LmGen(lm, max_steps=m.max_gen_length, text_sampler=Sampler(temp=m.temp),
                         audio_sampler=Sampler(temp=m.temp), cfg_coef=m.cfg_coef,
                         on_text_hook=on_text_hook, on_audio_hook=on_audio_hook)

    def add_text(self, text: str) -> None:
        if not text.strip():
            return
        entries = script_to_entries(self.m.tokenizer, self.m.machine.token_ids,
                                    self.m.mimi.frame_rate, [text],
                                    multi_speaker=self.first and self.m.multi_speaker,
                                    padding_between=1)
        self.first = False
        self.state.entries.extend(entries)

    def finish(self) -> None:
        self.final = True

    @property
    def done(self) -> bool:
        return self.tail_steps is not None and self.tail_steps <= 0

    def can_step(self) -> bool:
        if self.done:
            return False
        if self.final:
            return True
        return len(self.state.entries) > self.m.machine.second_stream_ahead

    def step(self) -> np.ndarray | None:
        """Runs one 80 ms generation step; returns decoded PCM when a frame is ready."""
        if self.final and self.tail_steps is None and not self.state.entries \
                and self.state.end_step is not None:
            self.tail_steps = self.m.delay_steps + max(self.m.lm.delays) + 8
        if self.tail_steps is not None:
            self.tail_steps -= 1
        if self.offset >= self.m.max_gen_length - 1:
            self.tail_steps = 0
            return None
        lm = self.m.lm
        missing = lm.n_q - lm.dep_q
        inp = mx.ones((1, missing), dtype=mx.int64) * self.m.machine.token_ids.zero
        self.gen.step(inp, ct=self.ct, cross_attention_src=self.ca_src)
        frame = self.gen.last_audio_tokens()
        self.offset += 1
        if frame is None or (frame == -1).any():
            return None
        pcm = self.m.mimi.decode_step(frame[:, :, None])
        return np.array(mx.clip(pcm[0, 0], -1, 1), dtype=np.float32)


# --------------------------------------------------------------------------- audio engine


class MacVoiceIO:
    """Mic and speakers through macOS voice processing, the echo canceller FaceTime uses.

    Claude's voice goes out through the same engine the mic comes in on, so macOS can
    subtract it from the mic signal before the STT ever hears it.
    """

    AHEAD = 3  # output frames queued in the player (~240 ms), kept small so barge-in is instant

    def __init__(self, on_mic: tp.Callable[[np.ndarray], None],
                 pull: tp.Callable[[], np.ndarray | None], on_played: tp.Callable[[], None]):
        self.on_mic = on_mic
        self.pull = pull
        self.on_played = on_played
        self.running = False
        self.scheduled = 0
        self.lock = threading.Lock()
        self.pending = np.zeros(0, np.float32)
        self.hist = np.zeros(2, np.float32)
        self.phase = 0

    def start(self) -> None:
        import AVFoundation as AVF

        self.AVF = AVF
        eng = AVF.AVAudioEngine.new()
        inp = eng.inputNode()
        # The output side must exist before voice processing is enabled, or start() fails (-10875).
        eng.outputNode()
        mixer = eng.mainMixerNode()
        ok, err = inp.setVoiceProcessingEnabled_error_(True, None)
        if not ok:
            raise RuntimeError(f"could not enable macOS voice processing: {err}")
        try:  # by default voice processing turns other apps' audio way down
            inp.setVoiceProcessingOtherAudioDuckingConfiguration_(
                AVF.AVAudioVoiceProcessingOtherAudioDuckingConfiguration(
                    False, AVF.AVAudioVoiceProcessingOtherAudioDuckingLevelMin))
        except Exception:
            pass
        self.player = AVF.AVAudioPlayerNode.new()
        eng.attachNode_(self.player)
        self.fmt = AVF.AVAudioFormat.alloc().initStandardFormatWithSampleRate_channels_(
            float(SAMPLE_RATE), 1)
        eng.connect_to_format_(self.player, mixer, self.fmt)
        self.rate = inp.outputFormatForBus_(0).sampleRate()
        # Tapping with the bus's own (multi-channel) format; channel 0 is the processed voice.
        inp.installTapOnBus_bufferSize_format_block_(0, 4800, None, self._tap)
        eng.prepare()
        ok, err = eng.startAndReturnError_(None)
        if not ok:
            raise RuntimeError(f"could not start the macOS audio engine: {err}")
        self.player.play()
        self.eng = eng
        self.running = True
        threading.Thread(target=self._feed, name="aec-output", daemon=True).start()

    def stop(self) -> None:
        if self.running:
            self.running = False
            self.eng.stop()

    def flush(self) -> None:
        """Drops whatever is queued in the player (barge-in)."""
        if self.running:
            self.player.stop()
            self.player.play()

    def _resample(self, x: np.ndarray) -> np.ndarray:
        if self.rate == SAMPLE_RATE:
            return x
        if self.rate == 2 * SAMPLE_RATE:  # 48 kHz: low-pass then keep every other sample
            z = np.concatenate([self.hist, x])
            self.hist = z[-2:]
            f = 0.25 * z[:-2] + 0.5 * z[1:-1] + 0.25 * z[2:]
            out = f[self.phase::2]
            self.phase = (self.phase - len(f)) % 2
            return out
        n = int(round(len(x) * SAMPLE_RATE / self.rate))
        return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)

    def _tap(self, buf, _when) -> None:
        n = buf.frameLength()
        x = np.frombuffer(buf.floatChannelData()[0].as_buffer(n), dtype=np.float32).copy()
        self.pending = np.concatenate([self.pending, self._resample(x)])
        while len(self.pending) >= FRAME:
            self.on_mic(self.pending[:FRAME].astype(np.float32))
            self.pending = self.pending[FRAME:]

    def _done(self) -> None:
        with self.lock:
            self.scheduled -= 1
        self.on_played()

    def _feed(self) -> None:
        while self.running:
            if self.scheduled < self.AHEAD:
                pcm = self.pull()
                if pcm is not None:
                    buf = self.AVF.AVAudioPCMBuffer.alloc().initWithPCMFormat_frameCapacity_(
                        self.fmt, FRAME)
                    buf.setFrameLength_(FRAME)
                    np.frombuffer(buf.floatChannelData()[0].as_buffer(FRAME),
                                  dtype=np.float32)[:] = pcm
                    with self.lock:
                        self.scheduled += 1
                    self.player.scheduleBuffer_completionHandler_(buf, self._done)
                    continue
            time.sleep(0.01)


@dataclass
class Segment:
    epoch: int
    kind: str  # "reply" | "prompt" | "system"
    texts: collections.deque = field(default_factory=collections.deque)
    ended: bool = False
    utt: Utterance | None = None


class AudioEngine:
    """Owns the mic, the speakers, and the single thread that runs both MLX models."""

    BUFFER_TARGET = 20  # TTS frames to keep queued for playback (~1.6 s)

    def __init__(self, args: argparse.Namespace, emit: tp.Callable[[tuple], None]):
        self.args = args
        self.emit = emit
        self.mic_q: queue.Queue[np.ndarray] = queue.Queue()
        self.codes_q: queue.Queue[np.ndarray] = queue.Queue()
        self.cmd_q: queue.Queue[tuple] = queue.Queue()
        self.out_frames: collections.deque[np.ndarray] = collections.deque()
        self.segments: collections.deque[Segment] = collections.deque()
        self.min_epoch = 0
        self.max_epoch_seen = 0
        self.last_audio_t = 0.0
        self.recent_spoken: collections.deque[tuple[float, str]] = collections.deque(maxlen=80)
        self.ready = threading.Event()
        self.error: BaseException | None = None
        self.running = True
        self.recorded: list[np.ndarray] = []
        self.aec = not (args.no_aec or args.input_wav or args.input_device is not None
                        or args.output_device is not None)
        self.io: MacVoiceIO | None = None

        # utterance state
        self.words: list[str] = []
        self.pending = ""
        self.last_piece_step = 0
        self.eot_steps = 0
        self.barged = False

        self.thread = threading.Thread(target=self._run, name="mlx-compute", daemon=True)

    # ---- called from the asyncio side

    def start(self) -> None:
        self.thread.start()

    def send(self, *cmd) -> None:
        self.cmd_q.put(cmd)

    def stop(self) -> None:
        self.running = False

    # ---- audio I/O

    def _out_callback(self, outdata, frames, _t, _status):
        try:
            pcm = self.out_frames.popleft()
            outdata[:, 0] = pcm
            self.last_audio_t = time.monotonic()
        except IndexError:
            outdata[:] = 0

    def _in_callback(self, indata, _frames, _t, _status):
        self.mic_q.put(indata[:, 0].copy())

    def _pull_frame(self) -> np.ndarray | None:
        try:
            return self.out_frames.popleft()
        except IndexError:
            return None

    def _mark_played(self) -> None:
        self.last_audio_t = time.monotonic()

    def _wav_io(self) -> None:
        """Test mode: plays a WAV file as the mic (then silence) and records the output."""
        pcm, sr = sphn.read(self.args.input_wav, sample_rate=SAMPLE_RATE)
        pcm = pcm[0]
        delay = int(self.args.input_delay * SAMPLE_RATE)
        pcm = np.concatenate([np.zeros(delay, np.float32), pcm.astype(np.float32)])
        pos = 0
        t0 = time.monotonic()
        n = 0
        while self.running:
            chunk = pcm[pos:pos + FRAME]
            pos += FRAME
            if len(chunk) < FRAME:
                chunk = np.concatenate([chunk, np.zeros(FRAME - len(chunk), np.float32)])
            self.mic_q.put(chunk)
            out = np.zeros(FRAME, np.float32)
            self._out_callback(out[:, None], FRAME, None, None)
            self.recorded.append(out)
            n += 1
            time.sleep(max(0.0, t0 + n * FRAME_S - time.monotonic()))

    # ---- compute thread

    def _run(self) -> None:
        try:
            a = self.args
            log(f"loading STT {a.stt_repo} ...")
            self.stt = Stt(a.stt_repo)
            if not self.stt.has_vad:
                log("warning: this STT checkpoint has no end-of-turn head; using silence timeout")
            log(f"loading TTS {a.tts_repo} (voice: {a.voice}) ...")
            self.tts = Tts(a.tts_repo, a.voice_repo, a.voice, a.tts_quantize or None, a.tts_cfg)
            threading.Thread(target=self._encode_loop, name="mimi-encode", daemon=True).start()
            self.ready.set()
            if a.input_wav:
                threading.Thread(target=self._wav_io, daemon=True).start()
                self._loop()
            elif self.aec:
                self.io = MacVoiceIO(self.mic_q.put, self._pull_frame, self._mark_played)
                self.io.start()
                log("echo cancellation on (macOS voice processing)")
                try:
                    self._loop()
                finally:
                    self.io.stop()
            else:
                with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32",
                                    blocksize=FRAME, callback=self._in_callback,
                                    device=a.input_device), \
                     sd.OutputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32",
                                     blocksize=FRAME, callback=self._out_callback,
                                     device=a.output_device):
                    self._loop()
        except BaseException as e:  # surface load/audio errors to the main thread
            self.error = e
            self.ready.set()
            self.emit(("fatal", repr(e)))

    def _encode_loop(self) -> None:
        # rustymimi runs on the CPU, so encoding here overlaps with the GPU work.
        while self.running:
            try:
                pcm = self.mic_q.get(timeout=0.1)
            except queue.Empty:
                continue
            self.codes_q.put(self.stt.encode(pcm))

    def _loop(self) -> None:
        warned_at = 0.0
        while self.running:
            self._drain_commands()
            did = False
            try:
                while True:
                    self._stt_step(self.codes_q.get_nowait())
                    did = True
            except queue.Empty:
                pass
            # One TTS step between mic frames keeps playback ahead without starving the STT.
            if self.segments and len(self.out_frames) < self.BUFFER_TARGET:
                did = self._tts_step() or did
            if self.mic_q.qsize() + self.codes_q.qsize() > 12 \
                    and time.monotonic() - warned_at > 30:
                warned_at = time.monotonic()
                log("warning: falling behind real time (try --tts-quantize 4 or close GPU apps)")
            if not did:
                time.sleep(0.005)

    def _drain_commands(self) -> None:
        while True:
            try:
                cmd = self.cmd_q.get_nowait()
            except queue.Empty:
                return
            op, epoch = cmd[0], cmd[1]
            self.max_epoch_seen = max(self.max_epoch_seen, epoch)
            if epoch < self.min_epoch:
                continue
            if op == "seg_start":
                self.segments.append(Segment(epoch=epoch, kind=cmd[2]))
            elif op == "seg_text" and self.segments:
                self.segments[-1].texts.append(cmd[2])
                for w in cmd[2].split():
                    self.recent_spoken.append((time.monotonic(), norm_word(w)))
            elif op == "seg_end" and self.segments:
                self.segments[-1].ended = True
            elif op == "stop_audio":
                self._stop_audio()

    def _stop_audio(self) -> None:
        self.segments.clear()
        self.out_frames.clear()
        if self.io is not None:
            self.io.flush()
        self.min_epoch = self.max_epoch_seen + 1

    def _tts_step(self) -> bool:
        seg = self.segments[0]
        if seg.utt is None:
            if not seg.texts:
                if seg.ended:  # nothing speakable (e.g. a reply that was all code)
                    self.segments.popleft()
                    return True
                return False
            seg.utt = self.tts.utterance()
        while seg.texts:
            seg.utt.add_text(seg.texts.popleft())
        if seg.ended and not seg.utt.final:
            seg.utt.finish()
        if seg.utt.done:
            self.segments.popleft()
            return True
        if not seg.utt.can_step():
            return False
        pcm = seg.utt.step()
        if pcm is not None:
            self.out_frames.append(pcm)
        return True

    # ---- turn taking

    @property
    def speaking(self) -> bool:
        return bool(self.segments or self.out_frames)

    def _guard_active(self) -> bool:
        return self.speaking or time.monotonic() - self.last_audio_t < 1.2

    def _is_echo(self, w: str) -> bool:
        n = norm_word(w)
        if not n:
            return True
        now = time.monotonic()
        spoken = [s for t, s in self.recent_spoken if now - t < 30]
        if n in spoken:
            return True
        return any(difflib.SequenceMatcher(None, n, s).ratio() >= 0.8 for s in spoken)

    def _commit(self, w: str) -> None:
        if not w:
            return
        if self._guard_active():
            if self.args.half_duplex:
                return
            if not self.args.headphones and self._is_echo(w):
                return
        self.words.append(w)
        print(f"\033[36m{w}\033[0m ", end="", flush=True)
        if self.speaking and not self.args.half_duplex and not self.barged:
            # Without echo cancellation, wait for a second word so stray echo can't cut
            # Claude off.
            needed = 1 if self.args.headphones or self.io is not None else 2
            if len(self.words) >= needed or norm_word(w) in STOP_WORDS:
                self.barged = True
                self._stop_audio()
                self.emit(("barge_in",))

    def _stt_step(self, codes: np.ndarray) -> None:
        piece, pr_eot = self.stt.step(codes)
        step = self.stt.steps
        if step < self.last_piece_step:  # the STT context was reset
            self.last_piece_step = step
        if piece is not None:
            self.last_piece_step = step
            if piece.startswith("▁"):
                self._commit(self.pending)
                self.pending = piece[1:]
            else:
                self.pending += piece
        if not (self.words or self.pending):
            if step - self.last_piece_step > 50 and step > 2000:
                self.stt.reset()  # free the context while it's quiet
                self.last_piece_step = 0
            return
        self.eot_steps = self.eot_steps + 1 if pr_eot > self.args.eot_threshold else 0
        quiet = step - self.last_piece_step
        if (self.eot_steps >= 1 and quiet >= 6) or quiet >= self.args.silence_steps:
            self._commit(self.pending)
            self.pending = ""
            text = " ".join(self.words)
            self.words = []
            self.eot_steps = 0
            self.barged = False
            if text:
                print(flush=True)
                self.emit(("utterance", text))


# --------------------------------------------------------------------------- speech cleanup


class SpeechFilter:
    """Turns streamed markdown-ish text into speakable chunks of whole words."""

    def __init__(self):
        self.buf = ""
        self.in_code = False

    def feed(self, delta: str, final: bool = False) -> str:
        self.buf += delta
        if final:
            chunk, self.buf = self.buf, ""
        else:
            cut = max(self.buf.rfind(" "), self.buf.rfind("\n"))
            if cut < 0:
                return ""
            chunk, self.buf = self.buf[: cut + 1], self.buf[cut + 1:]
        out = []
        for line in chunk.splitlines(keepends=True):
            if line.lstrip().startswith("```"):
                self.in_code = not self.in_code
                continue
            if not self.in_code:
                out.append(line)
        return self.clean("".join(out))

    @staticmethod
    def clean(text: str) -> str:
        text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
        text = re.sub(r"https?://\S+", "a link", text)
        text = re.sub(r"^\s*(#+|[-*+]|\d+\.)\s+", "", text, flags=re.M)
        text = re.sub(r"(?<=\w)\.(?=[A-Za-z])", " dot ", text)  # voice_claude.py -> ... dot py
        text = re.sub(r"(?<=\w)[_/](?=\w)", " ", text)
        text = re.sub(r"([^\s.,!?:;])[ \t]*\n+", r"\1, ", text)  # list items become a spoken list
        text = re.sub(r"[*_`|>#~]", "", text)
        text = text.replace("—", ", ").replace("–", " to ").replace("&", " and ")
        text = re.sub(r"\s+", " ", text)
        return text if text.strip() else ""


def describe_tool(name: str, inp: dict) -> str:
    def short(s: str, n: int = 14) -> str:
        words = str(s).split()
        return " ".join(words[:n]) + (" and so on" if len(words) > n else "")

    path = inp.get("file_path") or inp.get("path") or inp.get("notebook_path")
    base = os.path.basename(path) if path else None
    if name == "Bash":
        return f"run a command: {inp.get('description') or short(inp.get('command', ''))}"
    if name in ("Edit", "MultiEdit"):
        return f"edit {base}"
    if name == "Write":
        return f"write the file {base}"
    if name == "NotebookEdit":
        return f"edit the notebook {base}"
    if name == "WebFetch":
        return f"fetch a web page from {urlparse(inp.get('url', '')).netloc or 'the web'}"
    if name == "WebSearch":
        return f"search the web for {short(inp.get('query', ''), 10)}"
    return f"use the {name} tool"


# --------------------------------------------------------------------------- Claude Code side


class VoiceSession:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.loop = asyncio.get_running_loop()
        self.events: asyncio.Queue[tuple] = asyncio.Queue()
        self.inputs: asyncio.Queue[str] = asyncio.Queue()
        self.audio = AudioEngine(args, self._emit)
        self.client: ClaudeSDKClient | None = None
        self.epoch = 0
        self.busy = False
        self.turn_cancelled = False
        self.approval: asyncio.Future[str] | None = None
        self.turns_done = 0

    def _emit(self, ev: tuple) -> None:
        self.loop.call_soon_threadsafe(self.events.put_nowait, ev)

    def say(self, text: str, kind: str = "system") -> None:
        self.audio.send("seg_start", self.epoch, kind)
        self.audio.send("seg_text", self.epoch, SpeechFilter.clean(text))
        self.audio.send("seg_end", self.epoch)

    async def run(self) -> None:
        a = self.args
        self.audio.start()
        await asyncio.to_thread(self.audio.ready.wait)
        if self.audio.error:
            raise SystemExit(f"failed to start audio/models: {self.audio.error!r}")

        options = ClaudeAgentOptions(
            cwd=a.cwd,
            cli_path=shutil.which("claude"),
            include_partial_messages=True,
            system_prompt={"type": "preset", "preset": "claude_code", "append": VOICE_PROMPT},
            setting_sources=["user", "project", "local"],
            permission_mode=a.permission_mode,
            can_use_tool=self.can_use_tool,
            model=a.model,
            resume=a.resume,
            continue_conversation=a.continue_,
        )
        log(f"starting Claude Code in {a.cwd} (permission mode: {a.permission_mode})")
        async with ClaudeSDKClient(options) as client:
            self.client = client
            worker = asyncio.create_task(self.claude_worker())
            mode = "headphones" if a.headphones else ("half duplex" if a.half_duplex else "speakers")
            if self.audio.aec:
                mode += ", echo cancellation"
            print(f"\n\033[1mReady.\033[0m Talk to Claude Code. ({mode}; Ctrl-C to quit)\n",
                  flush=True)
            if not a.input_wav:
                self.say("Ready.")
            try:
                while True:
                    ev = await self.events.get()
                    if ev[0] == "fatal":
                        raise SystemExit(f"audio engine failed: {ev[1]}")
                    await self.handle(ev)
                    if a.max_turns and self.turns_done >= a.max_turns and not self.busy:
                        break
            finally:
                worker.cancel()

    async def handle(self, ev: tuple) -> None:
        if ev[0] == "barge_in":
            self.epoch += 1
            if self.approval is None and self.busy and not self.turn_cancelled:
                self.turn_cancelled = True
                log("\n[interrupted]")
                assert self.client is not None
                await self.client.interrupt()
        elif ev[0] == "utterance":
            text = ev[1]
            if self.approval is not None and not self.approval.done():
                self.approval.set_result(text)
                return
            if self.busy and not self.turn_cancelled:
                if {norm_word(w) for w in text.split()} & STOP_WORDS and len(text.split()) <= 4:
                    self.audio.send("stop_audio", self.epoch)
                    self.epoch += 1
                    self.turn_cancelled = True
                    log("[stopped]")
                    assert self.client is not None
                    await self.client.interrupt()
                    return
                log("[queued until Claude finishes this step]")
            await self.inputs.put(text)
        elif ev[0] == "turn_done":
            self.turns_done += 1

    async def claude_worker(self) -> None:
        assert self.client is not None
        while True:
            text = await self.inputs.get()
            while not self.inputs.empty():
                text += " " + self.inputs.get_nowait()
            self.busy = True
            self.turn_cancelled = False
            print(f"\033[1;36myou:\033[0m {text}", flush=True)
            try:
                await self.client.query(text)
                await self.stream_reply()
            except Exception as e:  # keep the session alive across errors
                log(f"[error] {e!r}")
                self.say("Sorry, something went wrong talking to Claude Code.")
            finally:
                self.busy = False
                self._emit(("turn_done",))

    async def stream_reply(self) -> None:
        assert self.client is not None
        speech: SpeechFilter | None = None
        printed_header = False
        async for msg in self.client.receive_response():
            if isinstance(msg, StreamEvent):
                if msg.parent_tool_use_id is not None:
                    continue  # subagent chatter stays silent
                ev = msg.event
                et = ev.get("type")
                if et == "content_block_start" and ev["content_block"].get("type") == "text":
                    speech = SpeechFilter()
                    if not self.turn_cancelled:
                        self.audio.send("seg_start", self.epoch, "reply")
                    if not printed_header:
                        print("\033[1;35mclaude:\033[0m ", end="", flush=True)
                        printed_header = True
                elif et == "content_block_delta" and ev["delta"].get("type") == "text_delta":
                    delta = ev["delta"]["text"]
                    print(delta, end="", flush=True)
                    if speech and not self.turn_cancelled:
                        chunk = speech.feed(delta)
                        if chunk:
                            self.audio.send("seg_text", self.epoch, chunk)
                elif et == "content_block_stop" and speech is not None:
                    if not self.turn_cancelled:
                        chunk = speech.feed("", final=True)
                        if chunk:
                            self.audio.send("seg_text", self.epoch, chunk)
                        self.audio.send("seg_end", self.epoch)
                    speech = None
                    print(flush=True)
            elif isinstance(msg, AssistantMessage) and msg.parent_tool_use_id is None:
                if msg.error:
                    detail = " ".join(b.text for b in msg.content if isinstance(b, TextBlock))
                    log(f"[claude error: {msg.error}] {detail}")
                    if msg.error == "authentication_failed":
                        self.say("Claude Code isn't logged in. Run claude auth login in a "
                                 "terminal, then restart me.")
                    else:
                        self.say(f"Claude Code hit an error: {msg.error.replace('_', ' ')}.")
                for block in msg.content:
                    if isinstance(block, ToolUseBlock):
                        detail = block.input.get("command") or block.input.get("file_path") \
                            or block.input.get("pattern") or block.input.get("url") or ""
                        log(f"  [{block.name}] {str(detail)[:160]}")
            elif isinstance(msg, ResultMessage):
                if msg.is_error and not self.turn_cancelled:
                    log(f"[claude: {msg.subtype}]")
                cost = f" ${msg.total_cost_usd:.3f}" if msg.total_cost_usd else ""
                log(f"[turn done in {msg.duration_ms / 1000:.1f}s{cost}]")

    async def can_use_tool(self, tool_name: str, tool_input: dict,
                           ctx: ToolPermissionContext):
        desc = describe_tool(tool_name, tool_input)
        log(f"[permission] {tool_name}: {json.dumps(tool_input)[:300]}")
        if self.turn_cancelled:
            return PermissionResultDeny(message="The user interrupted.", interrupt=True)
        self.approval = self.loop.create_future()
        self.say(f"Claude wants to {desc}. Should I allow it?", kind="prompt")
        try:
            answer = await asyncio.wait_for(self.approval, timeout=self.args.approval_timeout)
        except asyncio.TimeoutError:
            log("[permission] no answer, denied")
            self.say("No answer, so I denied it.")
            return PermissionResultDeny(message="The user did not answer the permission prompt.")
        finally:
            self.approval = None
        print(f"\033[1;36myou:\033[0m {answer}", flush=True)
        words = [norm_word(w) for w in answer.split()]
        first = next((w for w in words if w), "")
        if first in YES_WORDS and not (set(words[:3]) & NO_WORDS - {"do"}):
            log("[permission] allowed")
            return PermissionResultAllow()
        if first in NO_WORDS and len(words) <= 2:
            log("[permission] denied")
            return PermissionResultDeny(message="The user said no.")
        log("[permission] denied with feedback")
        return PermissionResultDeny(
            message=f"The user did not approve this. They said: \"{answer}\". Adjust accordingly.")


# --------------------------------------------------------------------------- main


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--cwd", default=os.getcwd(), help="project folder Claude Code works in")
    p.add_argument("--model", help="Claude model (default: your Claude Code default)")
    p.add_argument("--permission-mode", default="default",
                   choices=["default", "acceptEdits", "plan", "bypassPermissions"],
                   help="Claude Code permission mode; prompts are answered by voice")
    p.add_argument("--resume", help="resume a Claude Code session id")
    p.add_argument("--continue", dest="continue_", action="store_true",
                   help="continue the most recent Claude Code conversation in --cwd")
    p.add_argument("--headphones", action="store_true",
                   help="only with real headphones: turns off the word-level echo filter")
    p.add_argument("--no-aec", action="store_true",
                   help="don't use macOS echo cancellation (it's on by default and uses the "
                        "system default mic/speakers)")
    p.add_argument("--half-duplex", action="store_true",
                   help="ignore the mic while Claude speaks (last resort for echo problems)")
    p.add_argument("--voice", default=DEFAULT_VOICE, help="voice from kyutai/tts-voices")
    p.add_argument("--voice-repo", default=DEFAULT_DSM_TTS_VOICE_REPO)
    p.add_argument("--stt-repo", default=DEFAULT_STT_REPO)
    p.add_argument("--tts-repo", default=DEFAULT_DSM_TTS_REPO)
    p.add_argument("--tts-quantize", type=int, choices=[0, 4, 8], default=8,
                   help="quantize the TTS model; 8-bit is ~2.5x faster than bf16 (0 = off)")
    p.add_argument("--tts-cfg", type=float, default=2.0, help="TTS guidance strength (1.0-4.0)")
    p.add_argument("--eot-threshold", type=float, default=0.5,
                   help="end-of-turn probability needed to send what you said")
    p.add_argument("--silence-steps", type=int, default=25,
                   help="fallback: send after this many 80 ms frames without new words")
    p.add_argument("--approval-timeout", type=float, default=60.0)
    p.add_argument("--input-device", help="sounddevice input device name or index")
    p.add_argument("--output-device", help="sounddevice output device name or index")
    p.add_argument("--list-devices", action="store_true")
    # testing without a mic
    p.add_argument("--input-wav", help="use a WAV file as the mic (test mode)")
    p.add_argument("--input-delay", type=float, default=1.0, help="seconds before the WAV plays")
    p.add_argument("--output-wav", help="record what Claude says to this WAV (test mode)")
    p.add_argument("--max-turns", type=int, default=0, help="exit after N turns (test mode)")
    args = p.parse_args()
    for name in ("input_device", "output_device"):
        v = getattr(args, name)
        if v is not None and v.isdigit():
            setattr(args, name, int(v))
    return args


async def amain(args: argparse.Namespace) -> None:
    session = VoiceSession(args)
    try:
        await session.run()
        if args.max_turns:
            # let the last words play out
            deadline = time.monotonic() + 60
            while (session.audio.speaking or not session.audio.cmd_q.empty()) \
                    and time.monotonic() < deadline:
                await asyncio.sleep(0.2)
            await asyncio.sleep(1.0)
    finally:
        session.audio.stop()
        if args.output_wav and session.audio.recorded:
            sphn.write_wav(args.output_wav, np.concatenate(session.audio.recorded), SAMPLE_RATE)
            log(f"wrote {args.output_wav}")


def main() -> None:
    args = parse_args()
    if args.list_devices:
        print(sd.query_devices())
        return
    if shutil.which("claude") is None:
        log("note: `claude` not on PATH, using the CLI bundled with claude-agent-sdk")
    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        print("\nbye")
    # Skip interpreter teardown: the audio and MLX threads are still alive and freeing
    # them during finalization crashes ("malloc: double free").
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
