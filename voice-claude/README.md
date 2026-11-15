# Voice Claude: full-duplex voice for Claude Code on MLX

Talk to Claude Code with your voice, entirely on-device for the speech parts:

```
mic ─► Kyutai STT 1B (MLX) ─► Claude Code (Agent SDK) ─► Kyutai TTS 1.6B (MLX, 8-bit) ─► speakers
        streaming words +                                  starts speaking while
        semantic end-of-turn                               Claude is still writing
```

- **Full duplex**: talk over Claude at any time. It stops speaking, the Claude Code turn is
  interrupted, and what you said becomes the next message.
- **Spoken permission prompts**: when Claude wants to run a command or edit a file, it asks out
  loud. Say "yes" / "no", or say something else ("no, use pytest instead") and Claude gets that
  as feedback.
- Claude is told it's in voice mode, so it talks in short sentences and describes code instead
  of reading it. The full text (including any code) still streams in the terminal.
- Say "stop" or "wait" while Claude is working to interrupt it.

These are Kyutai's speech models from the same family as Moshi (same Mimi codec, same
`moshi_mlx` package). Moshi itself is a self-contained conversational model with its own brain,
so it can't relay another model's answers. This STT → LLM → TTS layout is how Kyutai's own
"Unmute" wraps a text LLM.

## Run it

One-time setup: log the `claude` CLI in. The bridge uses your normal Claude Code login.

```bash
claude auth login
```

Then, in Terminal.app, run it from this folder and point it at the project Claude should work in
(here, the webcontainer IDE one level up):

```bash
cd ~/Documents/webcontainer-project/webcontainer-ide/voice-claude
uv run voice_claude.py --cwd ..
```

The first run rebuilds the Python environment (`.venv`) automatically.

The first time, macOS will ask to let your terminal use the microphone. Allow it. Startup takes a few
seconds to load the models, then you'll hear "Ready."

### Echo cancellation (laptop speakers)

By default the bridge plays and records through **macOS voice processing**, the same echo canceller
FaceTime uses, so Claude's voice from the speakers is removed from the mic before the speech model
hears it. Measured on a MacBook Pro: the mic picks up Claude's voice about 22 dB quieter, and the
speech model hears none of it (with this off, it transcribed Claude's own sentence). You can
talk over Claude on plain laptop speakers, and one word interrupts it.

As a second line of defense, a word-level filter also drops any word Claude just said while it's
talking.

| Flag | Use when | Behavior |
| --- | --- | --- |
| *(none)* | laptop speakers or headphones | echo cancellation + word filter; one word interrupts |
| `--headphones` | real headphones only | also turns off the word filter |
| `--no-aec` | you need a specific mic/speaker device | plain audio; two words needed to interrupt |
| `--half-duplex` | echo problems remain | mic ignored while Claude talks (no interrupting) |

Echo cancellation always uses the system default mic and speakers (pick them in System Settings →
Sound). Passing `--input-device` / `--output-device` turns it off. While it runs, macOS may turn
other apps' audio down slightly. The bridge asks macOS to keep that to a minimum.

### Useful options

```
--permission-mode acceptEdits   auto-approve file edits (commands still ask by voice)
--continue                      pick up the most recent Claude Code conversation in --cwd
--resume SESSION_ID             resume a specific Claude Code session
--model opus                    choose the Claude model
--voice expresso/ex03-ex01_happy_001_channel1_334s.wav   any voice from huggingface.co/kyutai/tts-voices
--tts-quantize 4|8|0            TTS precision (8 = default, 0 = bf16, too slow for real time)
--eot-threshold 0.5             raise if it cuts you off mid-thought, lower for snappier turns
--list-devices / --input-device / --output-device
```

## Performance (M5 Pro, 64 GB, measured)

| Stage | Time per 80 ms audio frame |
| --- | --- |
| Mimi encode (rustymimi, CPU, own thread) | 21 ms |
| STT 1B, bf16 (GPU) | ~17 ms |
| TTS 1.6B, 8-bit (GPU) | ~50 ms (bf16 is 124 ms, too slow for real time) |

STT and TTS share one GPU thread (~67 ms of 80 ms). Typical latencies: end of your
sentence → sent to Claude ≈ 0.5–1 s; Claude's first words → audio ≈ 1 s; talking over Claude →
it goes quiet ≈ 1.5 s (headphones).

## Standalone Moshi (no Claude)

Moshi is also installed if you want to try Kyutai's own speech-to-speech model:

```bash
uv run python -m moshi_mlx.local_web -q 4
```

That opens a web UI at http://localhost:8998. `-q 4` uses `kyutai/moshiko-mlx-q4` (5 GB). For
better voice quality, use `--hf-repo kyutai/moshiko-mlx-q8 -q 8` (8.5 GB) or
`--hf-repo kyutai/moshiko-mlx-bf16` (15 GB, needs the disk space). Use `moshika` in the
repo name for the female voice.

## Files

- `voice_claude.py`: the whole bridge (STT, TTS, turn-taking, Claude Code session)
- `pyproject.toml` / `uv.lock`: dependencies (`moshi_mlx`, `claude-agent-sdk`); `uv sync` recreates `.venv`
- Models are cached in `~/.cache/huggingface/hub` (about 6.5 GB, plus 5 GB for Moshi q4)

## Testing without a mic

```bash
say -o q.aiff "Hey Claude, what files are in this folder?" && ffmpeg -i q.aiff -ar 24000 -ac 1 q.wav
uv run voice_claude.py --input-wav q.wav --output-wav reply.wav --max-turns 1
```
