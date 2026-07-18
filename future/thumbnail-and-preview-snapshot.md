# Thumbnails, preview snapshots & the blurred "paused" preview

> **Update (July 2026):** the server-side Puppeteer thumbnail renderer has been
> REVIVED for the sandbox workspace as `src/lib/server-screenshot.ts`, invoked
> from `POST /api/projects/[id]/snapshot` (Path B: rasterize the captured HTML
> snapshot, rate-limited via the daily screenshot counter). The client-side
> html2canvas rasterizer it describes is gone for good. Swift projects get
> thumbnails from simulator screengrabs composited into the device bezel by
> `src/lib/swift-thumbnail.ts` (from `swift-preview/screenshot`). The rest of
> this doc remains historical reference.
>
> **Status:** REMOVED from the codebase during the WebContainer deprecation
> (the capture routes + `snapshot-capture.ts` were deleted; the blur/HTML-display
> still physically lives inside the dead `components/workspace/**` tree until that
> tree is removed). This doc is the design reference for reviving it; the actual
> source is recoverable from git history just before commit `904b03c`
> ("remove the preview-snapshot/thumbnail capture infrastructure").
>
> **Naming note:** the screengrab is done with **Puppeteer** (`puppeteer-core` +
> `@sparticuz/chromium`), not Playwright — despite how it's sometimes referred
> to colloquially.

This describes three connected pieces:
1. capturing a project's preview (a PNG **thumbnail** + a raw **HTML snapshot**),
2. saving them to **UploadThing** and recording the URLs/keys on the project row,
3. replaying the captured HTML behind a **blur overlay** as a "paused" poster
   for the preview tab until the live dev server is ready.

---

## 1. Capture

There are two capture paths that evolved over time. Both end at the same
UploadThing save + DB columns.

### Path A — live-URL server screenshot (Puppeteer)
`src/lib/snapshot-capture.ts` → `captureProjectSnapshot(previewUrl)` POSTs to
`src/app/api/screenshot/route.ts` with `{ url, captureHtml: true }`. That route:
- **Auth + tier rate-limit:** Clerk auth; `getUserTierAndLimits` →
  `maxScreenshotsPerDay`, counted via `getDailyScreenshots`/`incrementDailyScreenshots`.
- **SSRF allowlist (`validateScreenshotUrl`):** http(s) only; blocks cloud
  metadata IPs and private ranges; **only allows `*.webcontainer.io` /
  `*.webcontainer-api.io` and localhost**. (Reviving this for sandbox previews
  means extending the allowlist to the `*.vercel.run` proxy host.)
- **HTML:** plain server-side `fetch(url)` of the root document (no CORS issue
  server-side).
- **Screenshot:** `puppeteer-core` launched with `@sparticuz/chromium` in prod
  (`NODE_ENV==='production' && VERCEL`); in local dev it finds a system Chrome
  (`localChromePaths`), and if none is found it draws a placeholder PNG with the
  native `canvas` lib (lazy-`import`ed so the native `.node` binding doesn't
  break the Vercel build). Viewport 1280×720, `waitUntil: networkidle2`,
  `maxDuration = 30`.
- **Returns** `{ screenshot: base64Png, html }`.

The client (`captureProjectSnapshot`) turns the base64 back into a `Blob`, then
`uploadProjectSnapshot(projectId, { thumbnailBlob, htmlContent })` POSTs a
`multipart/form-data` to `src/app/api/projects/snapshot/route.ts` (see §2).

> `snapshot-capture.ts` also contains client-only `html2canvas` helpers
> (`captureScreenshot`, `captureIframeScreenshot`) that were earlier attempts to
> rasterize the preview in-browser. The server Puppeteer path superseded them;
> they're left for reference.

### Path B — in-app `postMessage` HTML capture (current primary)
The running preview app posts its own document HTML up to the parent:
`window.parent.postMessage({ type: 'HTML_SNAPSHOT', html }, ...)` (the producer
lives in the preview template/injected script, not in this repo). The workspace
listens in `src/components/workspace/index.tsx` (the `HTML_SNAPSHOT` branch,
guarded by `htmlCapturedRef` so it fires once per dev-server session) and:
1. POSTs the HTML to `src/app/api/projects/[id]/html-snapshot/route.ts` →
   uploads it as a `.html` File to UploadThing, stores `htmlSnapshotUrl/Key`.
2. POSTs to `src/app/api/projects/[id]/generate-thumbnail-html/route.ts` →
   **Puppeteer renders the saved HTML** (`page.setContent`) to a PNG and uploads
   it as the thumbnail. (`src/app/api/projects/[id]/generate-thumbnail/route.ts`
   is the variant that screenshots the live URL instead.)

This path avoids the SSRF/preview-reachability problem of Path A because the
HTML is captured client-side from the iframe and rendered server-side from a
string rather than by navigating to the preview URL.

---

## 2. UploadThing save infrastructure

`src/app/api/projects/snapshot/route.ts` (and the dedicated `html-snapshot` /
`generate-thumbnail-html` routes) all use the same pattern via
`const utapi = new UTApi()` (`uploadthing/server`):
- Verify project ownership (Clerk userId === `projects.userId`).
- **Delete previous blobs first** if `project.thumbnailKey` / `htmlSnapshotKey`
  exist (`utapi.deleteFiles([...])`), so each project keeps exactly one current
  thumbnail + one HTML snapshot and we don't leak storage.
- `utapi.uploadFiles(file)` for the thumbnail (`thumbnail.png`) and/or the HTML
  (wrapped as `new File([Blob], 'snapshot-<ts>.html', { type: 'text/html' })`).
  HTML-upload failures are non-fatal (thumbnail still saved).
- Persist the returned `{ url, key }` onto the project row.

### DB columns (`src/db/schema.ts`, `projects` table)
```
thumbnailUrl      text  -- PNG thumbnail URL (card image)
thumbnailKey      text  -- UploadThing key, for deletion on replace
htmlSnapshotUrl   text  -- raw captured HTML document URL
htmlSnapshotKey   text  -- UploadThing key, for deletion on replace
```

`thumbnailUrl` is what the project cards render (`src/app/projects/page.tsx`,
`src/components/showcase/ShowcaseCard.tsx`), with a `Laptop` icon fallback when
it's null or the `<img>` errors.

---

## 3. The blurred "paused" preview

The captured HTML is replayed in a sandboxed iframe **behind a blur overlay** to
act as a static poster of the app while the real dev server boots (or after it
stops), so the preview tab is never an empty white box.

### Editor workspace — `src/components/workspace/preview.tsx`
- State: `snapshotHtml` (fetched from `htmlSnapshotUrl`), `showSnapshot`,
  `isRealPreviewLoaded`.
- Lifecycle:
  - On mount, `fetch(htmlSnapshotUrl).then(r=>r.text())` → `snapshotHtml`.
  - The **real** preview `<iframe>`'s `onLoad` sets `isRealPreviewLoaded`; when
    `isDevServerRunning && isRealPreviewLoaded`, `showSnapshot` flips to false
    (the poster is removed only once live content has actually painted).
  - When the dev server stops, `showSnapshot` is set back to true and
    `isRealPreviewLoaded` reset — the poster returns (the "paused" state).
- Render: while `showSnapshot && htmlSnapshotUrl && snapshotHtml`, an
  `<iframe srcDoc={snapshotHtml} sandbox="allow-scripts allow-same-origin ...">`
  is layered over the real preview. The device-frame variant additionally renders
  the snapshot iframe at `opacity: 0.6` under a `bg-black/40 backdrop-blur-[1px]`
  layer with a centered play button — the literal paused poster.

### Public viewer — `src/components/public-workspace/index.tsx`
While `!isReady`, it renders the snapshot iframe (`srcDoc={snapshotHtml}`,
`pointer-events-none`) — or falls back to the `thumbnailUrl` `<img>` — under a
`bg-black/40 backdrop-blur-[2px]` overlay containing a disabled Play button and
the boot status (spinner / error / "Loading…"). Clicking play boots the sandbox;
once ready the overlay is removed to reveal the live iframe.

---

## Dependencies
`puppeteer-core`, `@sparticuz/chromium`, `uploadthing` (`UTApi`), `canvas`
(local-dev placeholder only), `html2canvas` (legacy client rasterizer).

## Where it lived (recover from git history before `904b03c`)
- `src/lib/snapshot-capture.ts` — DELETED
- `src/app/api/screenshot/route.ts` — DELETED
- `src/app/api/projects/snapshot/route.ts` — DELETED
- `src/app/api/projects/[id]/html-snapshot/route.ts` — DELETED
- `src/app/api/projects/[id]/generate-thumbnail-html/route.ts` — DELETED
- `src/app/api/projects/[id]/generate-thumbnail/route.ts` — DELETED
- the snapshot/blur rendering blocks in `src/components/workspace/preview.tsx`
  and `src/components/public-workspace/index.tsx` — still present (dead) until the
  WebContainer workspace tree is removed
- the `projects.thumbnail*` / `projects.htmlSnapshot*` columns in `src/db/schema.ts`
  — KEPT (existing values still render on project cards)

## To revive for the Vercel-sandbox workspace
1. Extend `validateScreenshotUrl`'s allowlist to the sandbox preview host
   (`*.vercel.run`) — or prefer Path B (postMessage HTML capture), which is
   host-agnostic.
2. Ensure the sandbox preview template posts the `HTML_SNAPSHOT` message.
3. Wire the same `htmlSnapshotUrl` → blurred-`srcDoc` poster into the
   sandboxed-web preview component.
