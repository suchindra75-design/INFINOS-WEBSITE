'use client'

import { useEffect, useRef } from 'react'
import { useExperienceStore } from '@/state/experienceStore'
import { chapterAt } from '@/motion/chapters'
import { cameraAt } from '@/motion/cameraTrack'
import { compositionAt, layoutMode, maxScale, type Composition } from '@/motion/composition'
import { addRenderer, requestFrame } from '@/motion/frameLoop'
import { SEQUENCES, filmLayout, sequenceFrame, sequenceGain, sequenceLastCamera, type CameraPose, type SequenceDef, type SequenceId } from '@/motion/sequences'
import { extendFilmEdges } from './filmEdges'
import { PHONE_QUERY } from '@/motion/phoneLayout'
import { stageSize } from '@/hooks/environment'
import { decodeToPixels, isStaged, isWebKit, pixelDecoderBroken, stagePixels } from './pixelDecoder'

type Variant = 'desktop' | 'mobile'

/**
 * The live 3D layer's wrapper. Both layer opacities are written together in the frame loop, so the photoreal frame and
 * the live model always sum to a fully covered stage — no blank or double-exposed frame between them.
 */
export const liveLayerRef: { current: HTMLDivElement | null } = { current: null }

/**
 * Stable mount point for drei <Html> labels on the live model (the live layer itself, so they cross-fade with it).
 * Without it, Html re-targets from the canvas parent to R3F's event element once events connect, unmounting its own
 * React root during a render.
 */
export const htmlPortal = liveLayerRef as unknown as React.RefObject<HTMLElement>

/** the held opening frame's cross-fade to the live model once it is ready (ms) */
const HOLD_FADE_MS = 250

/**
 * The live layer's opacity while the photoreal frames cover it, once the model is ready: invisible (under one 8-bit
 * step even for white on black), but never 0. Each time a hidden WebGL canvas came back on screen, the browser's GPU
 * process set its surface up again — traced at ~0.95 s in Chrome on a dual-GPU Mac (GLContextEGL::MakeCurrent under
 * OnCreateSharedImage, as the GPU switched), independent of CPU speed — and the page froze for that long: on the first
 * swipe from the top (967 ms at 4x CPU throttle) and where the live model takes over from the open frames (1.1-1.2 s).
 * Kept on screen at this opacity the surface stays set up. The scene itself is not re-rendered while covered.
 */
const LIVE_HIDDEN_OPACITY = '0.002'

/** a decoded neighbour within this many frames may stand in for the exact frame while it is being decoded */
const MAX_FRAME_DISTANCE = 4

/**
 * WebKit: copying a new frame's pixels in costs ~7-18 ms of the page's frame (more while the GPU is busy). In a quick
 * scroll the frame changes on almost every screen frame, and copies on consecutive frames left no screen frame on time.
 * A new frame is copied in at most once per this many ms; in between, the frame already copied in stays (it is within a
 * few frames of the right one) while the composition keeps moving with the scroll every frame.
 */
const COPY_SPACING_MS = 24

interface Decoded {
  /** what to draw this frame from (in WebKit: the staging canvas, after copying this frame's pixels into it) */
  source: () => CanvasImageSource
  close: () => void
  /** WebKit: whether this frame's pixels are already in the staging canvas (drawing it costs no copy) */
  staged?: () => boolean
}

const webkit = isWebKit()

/**
 * Decode a compressed frame OFF the main thread. Drawing an <img> into a canvas makes Chrome decode the 2560 px WebP
 * synchronously inside the frame commit (~70 ms per new frame — the cause of the old scroll stutter); createImageBitmap
 * decodes on a worker thread. Frames are decoded at their native size on purpose: resize options make Chrome scale the
 * bitmap on the main thread (~50 ms per frame on phones), so each screen loads the frame set closest to its needs.
 * WebKit does both the decode and the first draw on the main thread instead; there frames become raw pixels in
 * workers (pixelDecoder.ts).
 */
async function decodeFrame(blob: Blob, workers: number): Promise<Decoded> {
  if (webkit && !pixelDecoderBroken()) {
    try {
      let pixels: ImageData | null = await decodeToPixels(blob, workers)
      return {
        source: () => stagePixels(pixels as ImageData),
        staged: () => !!pixels && isStaged(pixels),
        close: () => {
          pixels = null
        },
      }
    } catch {
      // no OffscreenCanvas in workers: decode on the page (below)
    }
  }
  if (typeof createImageBitmap === 'function' && !webkit) {
    try {
      const bmp = await createImageBitmap(blob)
      return { source: () => bmp, close: () => bmp.close() }
    } catch {
      // fall through (engines without Blob support in createImageBitmap)
    }
  }
  // (WebKit's img.decode() at least decodes off the main thread; its createImageBitmap does not)
  const url = URL.createObjectURL(blob)
  const img = new Image()
  img.src = url
  await img.decode()
  return { source: () => img, close: () => URL.revokeObjectURL(url) }
}

/**
 * One photoreal sequence: compressed frames are fetched once and kept (about 90 KB each); a bounded window of decoded
 * bitmaps follows the scroll position (ahead in the scroll direction first) and is evicted farthest-first, so memory
 * stays within a fixed budget however long the visitor scrolls.
 */
class FrameSet {
  readonly blobs: (Blob | null)[]
  readonly bitmaps = new Map<number, Decoded>()
  fetched = 0
  failed = false
  disposed = false
  private started = false
  private queue: number[] = []
  private inflight = 0
  private decoding = new Set<number>()
  private target = 0
  private dir = 1
  /** scroll speed through this sequence (frames per second, signed), from the positions the story asked for */
  private vel = 0
  private lastAt = 0
  private restTimer = 0
  /** how long one frame takes to decode here (ms, running average), measured as frames arrive */
  private decodeMs = 80

  constructor(
    readonly id: SequenceId,
    readonly def: SequenceDef,
    readonly variant: Variant,
    private readonly order: 'sequential' | 'progressive',
    private readonly maxBitmaps: number,
    private readonly concurrency: number,
    private readonly onFetched: (set: FrameSet, index: number) => void,
    private readonly onDecoded: (set: FrameSet, index: number) => void,
  ) {
    this.blobs = new Array(def.frames).fill(null)
  }

  url(i: number) {
    return `${this.def.dir}/${this.variant}/${String(i).padStart(4, '0')}.webp`
  }

  start() {
    if (this.started) return
    this.started = true
    const n = this.def.frames
    const seen = new Set<number>()
    const push = (i: number) => {
      if (i >= 0 && i < n && !seen.has(i)) {
        seen.add(i)
        this.queue.push(i)
      }
    }
    if (this.order === 'sequential') {
      for (let i = 0; i < n; i++) push(i)
    } else {
      push(0)
      push(n - 1)
      for (const stride of [16, 8, 4, 2, 1]) for (let i = 0; i < n; i += stride) push(i)
    }
    this.pumpFetch()
  }

  private pumpFetch() {
    while (!this.disposed && !this.failed && this.inflight < 6 && this.queue.length) {
      const i = this.queue.shift() as number
      this.inflight++
      fetch(this.url(i))
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
        .then((blob) => {
          this.inflight--
          if (this.disposed) return
          this.blobs[i] = blob
          this.fetched++
          this.onFetched(this, i)
          this.pumpDecode()
          this.pumpFetch()
        })
        .catch(() => {
          this.inflight--
          if (this.disposed) return
          if (i === 0) this.failed = true // no frames deployed: the live 3D path covers this chapter
          this.pumpFetch()
        })
    }
  }

  /** the frame the visitor is looking at; decoding follows it */
  want(i: number) {
    const now = performance.now()
    const dt = this.lastAt ? now - this.lastAt : 0
    if (dt > 0 && dt < 250) {
      const a = 1 - Math.exp(-dt / 90)
      this.vel += (((i - this.target) * 1000) / dt - this.vel) * a
    } else this.vel = 0
    this.lastAt = now
    if (i !== this.target) this.dir = i > this.target ? 1 : -1
    this.target = i
    // once the scroll has stopped (no frame asked for since), decode the frame it stopped on and its neighbours
    window.clearTimeout(this.restTimer)
    this.restTimer = window.setTimeout(() => this.pumpDecode(), 170)
    if (!this.blobs[i] && this.queue.includes(i)) {
      // visitor jumped ahead of the download: fetch the neighbourhood first
      const near = this.queue.filter((q) => Math.abs(q - i) <= 6).sort((a, b) => Math.abs(a - i) - Math.abs(b - i))
      const set = new Set(near)
      this.queue = [...near, ...this.queue.filter((q) => !set.has(q))]
      this.start()
      this.pumpFetch()
    }
    this.pumpDecode()
  }

  /** the scroll speed now (frames per second); the story stops asking for frames once the page is at rest */
  private velocity() {
    return performance.now() - this.lastAt > 150 ? 0 : this.vel
  }

  /**
   * Decode order. At rest (or scrolling slowly): the frame on screen, then its neighbours, ahead in the scroll direction
   * first and a little behind for reversals. Scrolling faster than frames can be decoded (a 2560 px frame takes ~50-100
   * ms; a quick scroll asks for 100+ frames a second), decoding the frame on screen and its next neighbours only ever
   * finished frames the scroll had already passed, and the picture stuck on an old frame and jumped (measured: on
   * average 8 frames behind, up to 23). Instead it decodes where the scroll will be when the decode finishes, at a
   * spacing the decoder can keep up with, on a fixed grid so a frame chosen once stays chosen while the scroll goes on:
   * the picture keeps moving with the scroll in slightly larger steps and settles on the exact frame when it stops.
   */
  private priorities(): number[] {
    const n = this.def.frames
    const v = this.velocity()
    const ahead = Math.max(2, Math.ceil(this.maxBitmaps * 0.65))
    const lead = Math.round((v * this.decodeMs) / 1000)
    const out: number[] = []
    if (Math.abs(lead) <= 1) {
      // the frame on screen and its nearest neighbours, then the rest of the sequence ahead at even spacing: a swipe
      // from rest (the first one from the top of the page, most often) finds a decoded frame near every position at
      // once, and the decoder fills in between as it goes
      const t = this.target
      const dir = this.dir
      const near = 2
      out.push(t)
      for (let k = 1; k <= near; k++) out.push(t + dir * k, t - dir * k)
      const room = dir > 0 ? n - 1 - t : t
      const slots = ahead - near
      if (room > near) for (let k = 1; k <= slots; k++) out.push(t + dir * (near + Math.round((k * (room - near)) / slots)))
    } else {
      const dir = lead > 0 ? 1 : -1
      const perSecond = (this.concurrency * 1000) / this.decodeMs
      const stride = Math.min(8, Math.max(1, Math.ceil(Math.abs(v) / perSecond)))
      // first grid frame at or beyond where the scroll will be when a decode started now has finished
      const from = this.target + lead
      let g = dir > 0 ? Math.ceil(from / stride) * stride : Math.floor(from / stride) * stride
      for (let k = 0; k < ahead && g >= 0 && g < n; k++, g += dir * stride) out.push(g)
      // the end of the sequence (the hand-over frame) and the frame on screen, for when the scroll stops
      out.push(dir > 0 ? n - 1 : 0, this.target)
    }
    return out.filter((i) => i >= 0 && i < n)
  }

  private pumpDecode() {
    if (this.disposed) return
    for (const i of this.priorities()) {
      if (this.decoding.size >= this.concurrency) break
      if (this.bitmaps.has(i) || this.decoding.has(i)) continue
      const blob = this.blobs[i]
      if (!blob) continue
      this.decoding.add(i)
      const started = performance.now()
      decodeFrame(blob, this.concurrency)
        .then((d) => {
          this.decoding.delete(i)
          this.decodeMs += (performance.now() - started - this.decodeMs) * 0.2
          if (this.disposed) return d.close()
          this.bitmaps.set(i, d)
          this.evict()
          this.onDecoded(this, i)
          this.pumpDecode()
        })
        .catch(() => {
          this.decoding.delete(i)
          this.pumpDecode()
        })
    }
  }

  /**
   * over budget: frames the decode order no longer wants go first — those the scroll has passed before those still
   * ahead of it — farthest first
   */
  private evict() {
    if (this.bitmaps.size <= this.maxBitmaps) return
    const keep = new Set(this.priorities())
    const rank = (i: number) => (keep.has(i) ? 2 : (i - this.target) * this.dir < 0 ? 0 : 1)
    const far = [...this.bitmaps.keys()].sort(
      (a, b) => rank(a) - rank(b) || Math.abs(b - this.target) - Math.abs(a - this.target),
    )
    for (const i of far) {
      if (this.bitmaps.size <= this.maxBitmaps) break
      // frame 0 stays: it is the page's resting frame (First Light, and the top of the story)
      if (Math.abs(i - this.target) <= 1 || i === 0) continue
      this.bitmaps.get(i)?.close()
      this.bitmaps.delete(i)
    }
  }

  /** nearest decoded frame to i and its distance in frames */
  nearest(i: number): { frame: Decoded; index: number; distance: number } | null {
    for (let d = 0; d <= MAX_FRAME_DISTANCE; d++) {
      const a = this.bitmaps.get(i - d)
      if (a) return { frame: a, index: i - d, distance: d }
      const b = this.bitmaps.get(i + d)
      if (b) return { frame: b, index: i + d, distance: d }
    }
    return null
  }

  /** the decoded frame closest to i, at any distance */
  closest(i: number): { frame: Decoded; index: number; distance: number } | null {
    let best: { frame: Decoded; index: number; distance: number } | null = null
    for (const [index, frame] of this.bitmaps) {
      const distance = Math.abs(index - i)
      if (!best || distance < best.distance) best = { frame, index, distance }
    }
    return best
  }

  dispose() {
    this.disposed = true
    window.clearTimeout(this.restTimer)
    for (const d of this.bitmaps.values()) d.close()
    this.bitmaps.clear()
  }
}

/**
 * Photoreal image-sequence layer. Frames are rendered offline in Blender Cycles from the same model, camera path and
 * opening stages as the live scene (src/content/sequences.json, tools/render_sequences.py), drawn with the same film
 * layout as the live camera, and cross-faded with the interactive 3D at chapter boundaries. Drawn from the shared
 * frame loop, in the same frame as the scroll update.
 */
export function ImageSequence() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const W = window.innerWidth
    const H = window.innerHeight
    const small = Math.min(W, H) < 700
    // the largest the film is ever drawn on this screen (composition.ts maxScale) decides the frame set
    const mode = layoutMode(W, H)
    const neededW = filmLayout(W, H, undefined, { x: 0.5, y: 0.5, s: maxScale(mode) }).w * dpr
    // Phones always take the 1600 px set. The common 412 px-wide Android screen (and 430 px phones) needs ~1690-1760 px,
    // just over the cut-off, and so loaded the 2560 px set: frames 2.5x slower to decode, twice the download, and the
    // phone's decode budget held only the minimum 6 of them — the reveal lagged 3-6 frames behind the swipe (up to 16)
    // on exactly those phones, against about 1 with the 1600 px set (Chrome, 4x CPU slowdown). Drawn ≤10 % larger than
    // its pixels on a 2.6-3x screen, the 1600 px frame looks the same (SSIM ≥ 0.993 against the 2560 px one).
    const variantFor = (def: SequenceDef): Variant =>
      mode !== 'phone' && neededW > (def.render?.mobileWidth ?? 960) * 1.05 ? 'desktop' : 'mobile'
    // decoded-bitmap memory budget (RGBA): ~70 MB on phones; on computers enough for ~24 full-size frames around the
    // scroll position (~400 MB), so a quick scroll starts on frames that are already decoded — less where the browser
    // reports little memory (navigator.deviceMemory, Chromium only)
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    const budget = (small ? 70 : memory !== undefined && memory < 8 ? 190 : 400) * 1024 * 1024

    const sets = {} as Record<SequenceId, FrameSet>
    const markOpeningReady = () => {
      if (!useExperienceStore.getState().openingReady) useExperienceStore.setState({ openingReady: true })
    }
    // Touch screens load the opening frames spread across the whole reveal first (every 16th, 8th, then 4th frame):
    // once those have arrived every moment of the reveal has a frame within two of it (FrameSet.nearest), so the story
    // can open without waiting for all 72 (about 3.5 MB on a phone); the rest fill in behind. Desktop keeps the
    // complete sequential preload.
    const touch = window.matchMedia('(hover: none) and (pointer: coarse)').matches
    const phoneLayout = window.matchMedia(PHONE_QUERY)
    const openingNeeds = (def: SequenceDef) => (touch ? Math.ceil(def.frames / 4) + 2 : def.frames)
    const onFetched = (set: FrameSet) => {
      if (set.id === 'reveal') {
        const progress = Math.min(1, set.fetched / openingNeeds(set.def))
        useExperienceStore.setState({ openingProgress: progress })
        if (progress >= 1 && set.bitmaps.has(0)) markOpeningReady()
        if (set.fetched >= set.def.frames && !phoneLayout.matches) sets.open.start()
      }
    }
    const onDecoded = (set: FrameSet, index: number) => {
      if (index === 0 && !useExperienceStore.getState().sequenceReady[set.id]) {
        const ready = useExperienceStore.getState().sequenceReady
        useExperienceStore.setState({ sequenceReady: { ...ready, [set.id]: true } })
        if (set.id === 'reveal' && set.fetched >= openingNeeds(set.def)) markOpeningReady()
      }
      requestFrame()
    }
    for (const id of Object.keys(SEQUENCES) as SequenceId[]) {
      const def = SEQUENCES[id]
      const variant = variantFor(def)
      const w = variant === 'desktop' ? def.render?.width ?? 2560 : def.render?.mobileWidth ?? 1600
      const h = variant === 'desktop' ? def.render?.height ?? 1600 : def.render?.mobileHeight ?? 1000
      const maxBitmaps = Math.max(6, Math.min(40, Math.floor(budget / (w * h * 4))))
      sets[id] = new FrameSet(id, def, variant, id === 'reveal' && !touch ? 'sequential' : 'progressive', maxBitmaps, small ? 2 : 3, onFetched, onDecoded)
    }

    // Safety nets: after 9 s continue once frame 0 is decoded (the frame-accuracy guard keeps the exact live model
    // visible for any frame not yet decoded); if no frames are deployed, continue immediately.
    const openingTimeout = window.setTimeout(() => {
      if (sets.reveal.bitmaps.has(0)) markOpeningReady()
    }, 9000)
    const failCheck = window.setInterval(() => {
      if (sets.reveal.failed) markOpeningReady()
      if (useExperienceStore.getState().openingReady) window.clearInterval(failCheck)
    }, 250)

    let lastKey = ''
    // WebKit copy pacing (COPY_SPACING_MS): the frame last drawn, and when a frame was last copied in
    let lastDrawn: { set: FrameSet; frame: Decoded; index: number } | null = null
    let lastCopyAt = -1e9
    // whether the last tick showed a frame (see the fallback in draw)
    let showing = false
    const comp: Composition = { x: 0.5, y: 0.5, s: 1 }
    // The photo layer lies over the live one. While the photo fades, the live model is drawn underneath at full strength
    // (it renders whenever it is not fully covered, liveLayer.ts) and only the photo dissolves: a cross-fade of two
    // half-transparent layers let the floor show through both mid-way, and with a live canvas that had not presented its
    // first frame yet it read as the bag vanishing for a moment (owner's device video, 2026-11-16).
    const setLayers = (seq: number, liveOn = seq < 0.999) => {
      const o = String(seq)
      if (canvas.style.opacity !== o) canvas.style.opacity = o
      const live = liveLayerRef.current
      // once the model is ready the layer is never fully hidden (see LIVE_HIDDEN_OPACITY)
      const lo = liveOn ? '1' : useExperienceStore.getState().modelReady ? LIVE_HIDDEN_OPACITY : '0'
      if (live && live.style.opacity !== lo) live.style.opacity = lo
    }
    const setFrameOk = (ok: boolean) => {
      if (useExperienceStore.getState().sequenceFrameOk !== ok) useExperienceStore.setState({ sequenceFrameOk: ok })
    }

    // The reveal's hand-over frame, held while the live model is still on its way (see draw)
    let hold = 0
    let holdFrom = -1
    let settleTicks = 0
    let pendingBefore = false
    const setHeld = (held: boolean) => {
      if (useExperienceStore.getState().stageHeld !== held) useExperienceStore.setState({ stageHeld: held })
    }

    const paint = (set: FrameSet, found: { frame: Decoded; index: number }, pose: CameraPose, progress: number, w: number, h: number, cw: number, ch: number) => {
      const key = `${set.id}:${found.index}:${w}x${h}:${progress.toFixed(5)}`
      if (key === lastKey) return
      lastKey = key
      // same framing as the live camera: pose subject placed by the editorial composition
      const l = filmLayout(cw, ch, pose, compositionAt(progress, layoutMode(cw, ch), comp, cw, ch))
      // whole device pixels: the shadow continued past the film edge (filmEdges.ts) then meets the frame without a
      // half-covered row between them (a sub-pixel shift, invisible, and well inside the live layer's alignment)
      const x = Math.round(-l.ox * dpr)
      const y = Math.round(-l.oy * dpr)
      const fw = Math.round((l.w - l.ox) * dpr) - x
      const fh = Math.round((l.h - l.oy) * dpr) - y
      ctx.clearRect(0, 0, w, h)
      // frames are decoded at (about) the drawn size, so plain GPU bilinear filtering is visually identical to
      // 'high' — which costs a slow resampling pass on every draw and dropped frames while scrubbing
      ctx.imageSmoothingQuality = 'low'
      const source = found.frame.source()
      ctx.drawImage(source, x, y, fw, fh)
      // on the lit studio floor the frame's shadow must not end at the film edge (filmEdges.ts)
      extendFilmEdges(ctx, source, set.id, found.index, x, y, fw, fh)
      // exposure match for the first open frames (sequences.json displayGainKeys): darken the drawn pixels only,
      // inside the canvas — a CSS filter on this full-screen layer would cost a GPU filter pass every frame
      const gain = sequenceGain(set.def, found.index / Math.max(1, set.def.frames - 1))
      if (gain < 0.999) {
        ctx.globalCompositeOperation = 'source-atop'
        ctx.fillStyle = `rgba(0,0,0,${(1 - gain).toFixed(3)})`
        ctx.fillRect(x, y, fw, fh)
        ctx.globalCompositeOperation = 'source-over'
      }
    }

    const draw = (now: number) => {
      // the canvas fills the stage: its size comes from the stage's ResizeObserver (hooks/environment.ts). Reading
      // clientWidth here, after the text and studio layers had written their styles in this same frame, forced a full
      // style recalculation every frame (traced: ~2.5 ms a frame on a phone at 4x CPU throttle)
      const { W: cw, H: ch } = stageSize()
      const w = Math.round(cw * dpr)
      const h = Math.round(ch * dpr)
      if (w !== canvas.width || h !== canvas.height) {
        canvas.width = w
        canvas.height = h
        lastKey = ''
      }
      const st = useExperienceStore.getState()
      const { progress, sequenceId, sequenceCover } = st
      const set = sequenceId ? sets[sequenceId as SequenceId] : undefined
      // phones play the open chapters on the live model (chapters.ts framesFor): their frames load only if the
      // screen turns to a layout that shows them
      if (progress > 0.12 && !phoneLayout.matches) sets.open.start()

      // Waiting for the live model. On a phone connection it arrives seconds after the intro (measured: ~5 s at 12
      // Mbps, ~8 s at 5 Mbps), and a visitor who swiped straight on found an empty floor under the hero's text. Until
      // it has drawn, the reveal's hand-over frame stays on the stage — the same bag, placed where the live one will
      // stand — and then cross-fades to it.
      const pending = st.webglSupported && !st.modelFailed && !st.modelReady && st.introPhase === 'ready'
      if (pending) hold = 1
      else if (hold > 0) {
        // the model is ready: it draws under the held frame for a few frames (so it has reached the screen), then the
        // held frame dissolves over it
        if (pendingBefore) {
          holdFrom = -1
          settleTicks = 0
        }
        if (holdFrom < 0) {
          if (++settleTicks >= 3) holdFrom = now
        } else hold = Math.max(0, 1 - (now - holdFrom) / HOLD_FADE_MS)
      }
      pendingBefore = pending
      const reveal = sets.reveal
      const framesHere = !!set && !set.failed && sequenceCover > 0.001

      if (!framesHere) {
        showing = false
        // the hand-over frame or a near neighbour (not, say, the pinned first frame: it is posed elsewhere)
        const last = reveal.def.frames - 1
        const near = hold > 0 && !reveal.failed ? reveal.closest(last) : null
        const held = near && near.distance <= MAX_FRAME_DISTANCE * 2 ? near : null
        setHeld(!!held && pending)
        if (hold > 0) reveal.want(last)
        if (!held) {
          setLayers(0)
          return
        }
        setLayers(hold, !pending)
        paint(reveal, held, sequenceLastCamera('reveal'), progress, w, h, cw, ch)
        // still fading: one more frame
        return hold > 0 && !pending
      }
      setHeld(false)

      const chapter = chapterAt(progress)
      const cp = Math.min(1, Math.max(0, (progress - chapter.start) / (chapter.end - chapter.start)))
      const index = sequenceFrame(set.def, chapter.hold ? 0 : cp)
      set.want(index)
      // Cover the live model only with a frame that shows (nearly) the right moment; otherwise the live scene, which is
      // always exact, stays visible until the right frame is decoded. Once frames are on screen, though, they stay: a
      // farther decoded frame stands in for the few ms until the right one arrives. Dropping to the live model for those
      // ms swapped the photo for a differently lit render and back — a visible flicker on phones, which decode slowly
      // and keep few frames (owner's device video, 2026-11-11).
      let found = set.nearest(index) ?? (showing ? set.closest(index) : null)
      showing = !!found
      let again = false
      if (found?.frame.staged && !found.frame.staged()) {
        const prev = lastDrawn
        if (now - lastCopyAt < COPY_SPACING_MS && prev && prev.set === set && set.bitmaps.get(prev.index) === prev.frame && Math.abs(prev.index - index) <= MAX_FRAME_DISTANCE) {
          found = { frame: prev.frame, index: prev.index, distance: Math.abs(prev.index - index) }
          again = true
        } else lastCopyAt = now
      }
      setFrameOk(!!found)
      // the reveal's own hand-over to the live model waits for the model as well (the held frame above continues it)
      setLayers(found ? Math.max(sequenceCover, sequenceId === 'reveal' ? hold : 0) : 0)
      if (!found) return
      paint(set, found, cameraAt(chapter.phase, cp), progress, w, h, cw, ch)
      lastDrawn = { set, frame: found.frame, index: found.index }
      return (hold > 0 && !pending) || again
    }

    const unregister = addRenderer(draw, 20)
    sets.reveal.start()

    return () => {
      for (const set of Object.values(sets)) set.dispose()
      window.clearTimeout(openingTimeout)
      window.clearInterval(failCheck)
      unregister()
    }
  }, [])

  return <canvas ref={canvasRef} className="sequence-canvas" aria-hidden="true" />
}
