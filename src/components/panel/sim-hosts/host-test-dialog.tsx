'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Play, Square, XCircle } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/badge';
import { Select } from '@/components/ui/field';
import { cn } from '@/lib/utils';
import { SimVideoDecoder } from '@/components/persistent-workspace/sim-video-decoder';
import { SwiftStreamClient, type SimSessionState } from '@/components/persistent-workspace/swift-stream-client';
import type { SimHost, SimHostTestResult } from '@/lib/sim-hosts/model';

/** Frame rate is averaged over this long once the first frame is on screen. */
const SAMPLE_MS = 10_000;

type Phase = 'idle' | 'provisioning' | 'queued' | 'building' | 'starting' | 'sampling' | 'done' | 'error';

interface Marks {
  clickAt: number;
  provisionedAt?: number;
  createMs?: number;
  uploadMs?: number;
  queuedAt?: number;
  buildStartedAt?: number;
  buildEndedAt?: number;
  buildMs?: number;
  streamingAt?: number;
  firstFrameAt?: number;
}

interface FpsStats {
  live: number;
  avg: number | null;
  min: number | null;
  sampledMs: number;
}

const fmtMs = (ms: number | null | undefined) =>
  ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

export function HostTestDialog({
  open,
  host,
  onClose,
  onSaved,
}: {
  open: boolean;
  host: SimHost;
  onClose: () => void;
  /** A result was saved to the host. */
  onSaved: () => void;
}) {
  const [deviceModel, setDeviceModel] = useState<'iPhone-16-Pro' | 'iPad-Pro'>('iPhone-16-Pro');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [marks, setMarks] = useState<Marks | null>(null);
  const [fps, setFps] = useState<FpsStats>({ live: 0, avg: null, min: null, sampledMs: 0 });
  const [video, setVideo] = useState<{ width: number; height: number; fps: number } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<SwiftStreamClient | null>(null);
  const decoderRef = useRef<SimVideoDecoder | null>(null);
  const sessionRef = useRef<string | null>(null);
  const marksRef = useRef<Marks | null>(null);
  const videoRef = useRef<{ width: number; height: number; fps: number } | null>(null);
  const phaseRef = useRef<Phase>('idle');
  const savedRef = useRef(false);
  // Frame counting: one-second buckets for the live/min rate, totals for the average.
  const fpsRef = useRef({ bucketStart: 0, bucketFrames: 0, total: 0, min: Infinity });

  const go = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };
  const mark = (patch: Partial<Marks>) => {
    if (!marksRef.current) return;
    marksRef.current = { ...marksRef.current, ...patch };
    setMarks(marksRef.current);
  };

  const release = useCallback(
    (keepalive = false) => {
      clientRef.current?.close();
      clientRef.current = null;
      decoderRef.current?.close();
      decoderRef.current = null;
      const sid = sessionRef.current;
      sessionRef.current = null;
      if (sid) {
        void fetch(`/api/panel/sim-hosts/${host.id}/test?sessionId=${sid}`, { method: 'DELETE', keepalive }).catch(
          () => undefined,
        );
      }
    },
    [host.id],
  );

  // End the session when the dialog closes or the page goes away.
  useEffect(() => {
    if (!open) release();
  }, [open, release]);
  useEffect(() => {
    const onHide = () => release(true);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      release(true);
    };
  }, [release]);

  const saveResult = useCallback(
    async (result: Omit<SimHostTestResult, 'at'>) => {
      if (savedRef.current) return;
      savedRef.current = true;
      try {
        const res = await fetch(`/api/panel/sim-hosts/${host.id}/test`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result),
        });
        if (res.ok) {
          setSaved(true);
          onSaved();
        }
      } catch {
        // Saving is a convenience; the numbers are still on screen.
      }
    },
    [host.id, onSaved],
  );

  const resultFrom = useCallback(
    (ok: boolean, err: string | null, stats?: FpsStats): Omit<SimHostTestResult, 'at'> => {
      const m = marksRef.current;
      const v = videoRef.current;
      return {
        ok,
        startupMs: m?.firstFrameAt ? Math.round(m.firstFrameAt - m.clickAt) : null,
        provisionMs: m?.provisionedAt ? Math.round(m.provisionedAt - m.clickAt) : null,
        buildMs: m?.buildMs ?? (m?.buildStartedAt && m.buildEndedAt ? Math.round(m.buildEndedAt - m.buildStartedAt) : null),
        avgFps: stats?.avg ?? null,
        minFps: stats?.min ?? null,
        targetFps: v?.fps ?? null,
        resolution: v ? `${v.width}×${v.height}` : null,
        error: err ? err.slice(0, 500) : null,
      };
    },
    [],
  );

  const fail = useCallback(
    (message: string) => {
      if (phaseRef.current === 'error' || phaseRef.current === 'done') return;
      setError(message);
      go('error');
      void saveResult(resultFrom(false, message));
      release();
    },
    [release, resultFrom, saveResult],
  );

  const onFrameDrawn = useCallback(() => {
    const now = performance.now();
    const f = fpsRef.current;
    const m = marksRef.current;
    if (!m) return;
    if (!m.firstFrameAt) {
      mark({ firstFrameAt: now });
      f.bucketStart = now;
      f.bucketFrames = 0;
      f.total = 0;
      f.min = Infinity;
      if (phaseRef.current !== 'done') go('sampling');
      return;
    }
    f.bucketFrames++;
    f.total++;
    const bucketMs = now - f.bucketStart;
    if (bucketMs >= 1000) {
      const rate = (f.bucketFrames * 1000) / bucketMs;
      const sampledMs = now - m.firstFrameAt;
      const sampling = phaseRef.current === 'sampling';
      // The first second after the first frame is decoder warm-up; leave it
      // out of the worst-second figure.
      if (sampling && sampledMs > 1_500) f.min = Math.min(f.min, rate);
      setFps((prev) => ({
        live: Math.round(rate),
        avg: sampling ? Math.round(((f.total * 1000) / sampledMs) * 10) / 10 : prev.avg,
        min: sampling && Number.isFinite(f.min) ? Math.round(f.min * 10) / 10 : prev.min,
        sampledMs: sampling ? sampledMs : prev.sampledMs,
      }));
      f.bucketStart = now;
      f.bucketFrames = 0;
      if (sampling && sampledMs >= SAMPLE_MS) {
        const stats: FpsStats = {
          live: Math.round(rate),
          avg: Math.round(((f.total * 1000) / sampledMs) * 10) / 10,
          min: Number.isFinite(f.min) ? Math.round(f.min * 10) / 10 : null,
          sampledMs,
        };
        setFps(stats);
        go('done');
        void saveResult(resultFrom(true, null, stats));
      }
    }
  }, [resultFrom, saveResult]);

  const draw = useCallback(
    (source: CanvasImageSource, w: number, h: number) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.drawImage(source, 0, 0, w, h);
      onFrameDrawn();
    },
    [onFrameDrawn],
  );

  async function start() {
    release();
    savedRef.current = false;
    setSaved(false);
    setError(null);
    setStatus(null);
    setLogs([]);
    setVideo(null);
    videoRef.current = null;
    setFps({ live: 0, avg: null, min: null, sampledMs: 0 });
    marksRef.current = { clickAt: performance.now() };
    setMarks(marksRef.current);
    go('provisioning');

    let body: { sessionId?: string; wsUrl?: string; createMs?: number; uploadMs?: number; error?: string };
    try {
      const res = await fetch(`/api/panel/sim-hosts/${host.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceModel }),
      });
      body = await res.json().catch(() => ({}));
      if (!res.ok || !body.sessionId || !body.wsUrl) {
        fail(body.error ?? `Couldn't start a session (HTTP ${res.status}).`);
        return;
      }
    } catch {
      fail('Network error while starting the session.');
      return;
    }
    if (phaseRef.current !== 'provisioning') {
      // Closed or restarted while the request was in flight.
      void fetch(`/api/panel/sim-hosts/${host.id}/test?sessionId=${body.sessionId}`, { method: 'DELETE' });
      return;
    }
    sessionRef.current = body.sessionId;
    mark({ provisionedAt: performance.now(), createMs: body.createMs, uploadMs: body.uploadMs });
    go('building');

    const client = new SwiftStreamClient(body.wsUrl, {
      onOpen: () => undefined,
      onState: (state: SimSessionState, _queuePosition, reason) => {
        if (state === 'queued') {
          // A session waiting for its upload is briefly "queued" even with free
          // slots; only call it queued if it stays that way.
          if (!marksRef.current?.queuedAt) {
            mark({ queuedAt: performance.now() });
            setTimeout(() => {
              if (phaseRef.current === 'building' && !marksRef.current?.buildStartedAt) go('queued');
            }, 3_000);
          }
        } else if (state === 'building') {
          go('building');
        } else if (state === 'starting') {
          go('starting');
        } else if (state === 'streaming') {
          if (!marksRef.current?.streamingAt) mark({ streamingAt: performance.now() });
          if (phaseRef.current !== 'sampling' && phaseRef.current !== 'done') go('starting');
        } else if (state === 'ended' || state === 'error') {
          if (phaseRef.current !== 'done') fail(reason ? `Session ${state}: ${reason}` : `Session ${state}.`);
        }
      },
      onCalibration: () => undefined,
      onFrame: (jpegBase64) => {
        const img = new Image();
        img.onload = () => draw(img, img.naturalWidth, img.naturalHeight);
        img.src = `data:image/jpeg;base64,${jpegBase64}`;
      },
      onVideoConfig: (config) => {
        const v = { width: config.width, height: config.height, fps: config.fps };
        videoRef.current = v;
        setVideo(v);
        if (!('VideoDecoder' in window)) {
          fail('This browser has no WebCodecs VideoDecoder. Use a Chromium browser to test the H.264 stream.');
          return;
        }
        decoderRef.current?.close();
        decoderRef.current = new SimVideoDecoder({
          width: config.width,
          height: config.height,
          onFrame: (frame) => draw(frame, frame.displayWidth, frame.displayHeight),
          onFatal: (message) => fail(`Video decoder error: ${message}`),
        });
      },
      onVideoChunk: (chunk, ts, keyframe) => decoderRef.current?.decode(chunk, ts, keyframe),
      onStatus: (message) => setStatus(message),
      onError: (message) => fail(message),
      onBuildStatus: (s) => {
        if (s.state === 'started') {
          mark({ buildStartedAt: performance.now() });
          go('building');
        } else if (s.state === 'succeeded') {
          mark({ buildEndedAt: performance.now(), buildMs: s.durationMs });
          go('starting');
        } else {
          fail(s.message ? `Build failed: ${s.message}` : 'Build failed.');
        }
      },
      onBuildLog: (line) => setLogs((l) => (l.length >= 300 ? [...l.slice(-299), line] : [...l, line])),
      onBuildDiagnostics: () => undefined,
      onClose: (code) => {
        if (phaseRef.current !== 'done' && phaseRef.current !== 'error') {
          fail(`The stream closed (code ${code}).`);
        }
      },
    });
    clientRef.current = client;
    client.start();
  }

  function stop() {
    release();
    // The measurements stay on screen; only the stream goes.
    if (phaseRef.current !== 'error') go('idle');
  }

  function onCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas || !clientRef.current) return;
    const r = canvas.getBoundingClientRect();
    clientRef.current.sendInput({
      kind: 'tap',
      normX: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      normY: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    });
  }

  const running = phase !== 'idle' && phase !== 'done' && phase !== 'error';
  const live = phase === 'sampling' || phase === 'done';
  const m = marks;
  const steps: Array<{ label: string; ms: number | null | undefined; active: boolean; done: boolean }> = [
    {
      label: 'Create session + upload demo app',
      ms: m?.provisionedAt ? m.provisionedAt - m.clickAt : undefined,
      active: phase === 'provisioning',
      done: Boolean(m?.provisionedAt),
    },
    {
      label: 'Build (host xcodebuild)',
      ms: m?.buildMs ?? (m?.buildStartedAt && m.buildEndedAt ? m.buildEndedAt - m.buildStartedAt : undefined),
      active: phase === 'building' || phase === 'queued',
      done: Boolean(m?.buildEndedAt),
    },
    {
      label: 'Boot, install, launch',
      ms: m?.buildEndedAt && m.streamingAt ? m.streamingAt - m.buildEndedAt : undefined,
      active: phase === 'starting' && !m?.streamingAt,
      done: Boolean(m?.streamingAt),
    },
    {
      label: 'First frame on screen',
      ms: m?.streamingAt && m.firstFrameAt ? m.firstFrameAt - m.streamingAt : undefined,
      active: phase === 'starting' && Boolean(m?.streamingAt),
      done: Boolean(m?.firstFrameAt),
    },
  ];
  const startupMs = m?.firstFrameAt ? m.firstFrameAt - m.clickAt : null;
  const fpsTone =
    fps.avg == null || !video ? 'text-fg' : fps.avg >= video.fps * 0.8 ? 'text-success' : fps.avg >= video.fps * 0.5 ? 'text-warning' : 'text-danger';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title={`Test ${host.name}`}
      description="Sends the built-in “Botflow host check” app to this host, whether it is serving or not, and measures how long it takes to appear and how smoothly it streams."
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Close
          </Button>
          {running || live ? (
            <Button type="button" variant="danger-outline" onClick={stop}>
              <Square className="h-3.5 w-3.5" /> End session
            </Button>
          ) : (
            <Button type="button" onClick={() => void start()}>
              <Play className="h-3.5 w-3.5" /> {phase === 'idle' ? 'Start test' : 'Run again'}
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-5">
          {phase === 'idle' && (
            <div className="flex flex-wrap items-end gap-3">
              <label className="block min-w-[200px] flex-1 space-y-1.5">
                <span className="block text-[13px] font-medium text-fg">Device</span>
                <Select value={deviceModel} onChange={(e) => setDeviceModel(e.target.value as typeof deviceModel)}>
                  <option value="iPhone-16-Pro">iPhone</option>
                  <option value="iPad-Pro">iPad</option>
                </Select>
              </label>
            </div>
          )}

          <div>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h3 className="text-[13px] font-semibold text-fg">Startup</h3>
              <span className="text-2xl font-semibold tabular-nums text-fg">{fmtMs(startupMs)}</span>
            </div>
            <ol className="divide-y divide-border rounded-lg border border-border">
              {steps.map((s) => (
                <li key={s.label} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                  <span className={cn('flex items-center gap-2', s.done || s.active ? 'text-fg' : 'text-muted')}>
                    {s.done ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                    ) : s.active ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />
                    ) : (
                      <span className="inline-block h-3.5 w-3.5 rounded-full border border-border" />
                    )}
                    {s.label}
                  </span>
                  <span className="tabular-nums text-muted">{fmtMs(s.ms)}</span>
                </li>
              ))}
            </ol>
            {phase === 'queued' && (
              <p className="mt-2 text-xs text-warning">Every slot on this host is busy; the test is queued.</p>
            )}
            {status && running && <p className="mt-2 text-xs text-muted">{status}</p>}
          </div>

          <div>
            <h3 className="mb-2 text-[13px] font-semibold text-fg">Frame rate</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric label="Now" value={live ? `${fps.live}` : '—'} />
              <Metric
                label={phase === 'done' ? `Average (${Math.round(fps.sampledMs / 1000)} s)` : 'Average'}
                value={fps.avg != null ? `${fps.avg}` : '—'}
                className={fpsTone}
              />
              <Metric label="Worst second" value={fps.min != null ? `${fps.min}` : '—'} />
              <Metric label="Stream target" value={video ? `${video.fps}` : '—'} sub={video ? `${video.width}×${video.height}` : undefined} />
            </div>
            {phase === 'sampling' && (
              <p className="mt-2 text-xs text-muted">
                Sampling for {Math.round(SAMPLE_MS / 1000)} s… {Math.min(Math.round(fps.sampledMs / 1000), SAMPLE_MS / 1000)} s so far.
              </p>
            )}
            {phase === 'done' && (
              <p className="mt-2 text-xs text-muted">
                {saved ? 'Saved as this host’s last test.' : 'Measured.'} The session stays open: tap the button in the
                app to check that input arrives.
              </p>
            )}
          </div>

          {error && (
            <Notice tone="danger" className="flex items-start gap-2">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </Notice>
          )}

          {logs.length > 0 && (
            <details className="rounded-lg border border-border" open={phase === 'error'}>
              <summary className="cursor-pointer px-3 py-2 text-[13px] text-muted">Build log ({logs.length} lines)</summary>
              <pre className="modern-scrollbar max-h-56 overflow-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed text-muted">
                {logs.join('\n')}
              </pre>
            </details>
          )}
        </div>

        <div className="flex justify-center">
          <div
            className={cn(
              'relative flex w-full max-w-[260px] items-center justify-center overflow-hidden rounded-[28px] border-[6px] border-fg/85 bg-black',
              deviceModel === 'iPad-Pro' ? 'aspect-[3/4]' : 'aspect-[9/19.5]',
            )}
          >
            <canvas
              ref={canvasRef}
              onClick={onCanvasClick}
              aria-label="Simulator screen. Click to tap."
              className={cn('h-full w-full object-contain', live ? 'cursor-pointer' : 'invisible')}
            />
            {!live && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-xs text-white/60">
                {running ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    {phase === 'provisioning' ? 'Starting session…' : phase === 'queued' ? 'Queued…' : phase === 'building' ? 'Building…' : 'Booting…'}
                  </>
                ) : phase === 'error' ? (
                  'No stream'
                ) : (
                  'Not running'
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function Metric({ label, value, sub, className }: { label: string; value: string; sub?: string; className?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={cn('text-lg font-semibold tabular-nums', className ?? 'text-fg')}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}
