/**
 * Frame decoding for WebKit (Safari on the Mac, every browser on iPhone and iPad).
 *
 * Measured in WebKit (Safari 27's engine on an Intel MacBook Pro, 2560 x 1600 frames with alpha):
 *  - createImageBitmap(blob) decodes on the page's main thread: the page stalled ~95 ms for every frame;
 *  - the first draw of a decoded image or bitmap into a canvas — 2D or WebGL — cost another 40-75 ms there, paid again
 *    for frames drawn before once more than a handful have been shown;
 *  - raw pixels (an ImageData) go into a canvas in ~7-18 ms.
 * While wheel-scrolling through the story the old path kept the main thread blocked for ~1.6 s of every 4 s, and a
 * fifth to a third of the wheel events were dropped. Here the frame is decoded AND turned into raw pixels inside a small
 * pool of workers; the page only copies the pixels into one staging canvas when that frame is about to be shown
 * (ImageSequence draws from the staging canvas, which stays on the GPU). Chrome and Firefox keep createImageBitmap: they
 * decode off the main thread and upload cheaply.
 */

const WORKER_SOURCE = `
let canvas = null
onmessage = async (e) => {
  const { id, blob } = e.data
  try {
    const bitmap = await createImageBitmap(blob)
    const w = bitmap.width, h = bitmap.height
    if (!canvas || canvas.width !== w || canvas.height !== h) canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.globalCompositeOperation = 'copy'
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    const data = ctx.getImageData(0, 0, w, h).data
    postMessage({ id, w, h, buf: data.buffer }, [data.buffer])
  } catch (err) {
    postMessage({ id, error: String(err), fatal: typeof OffscreenCanvas === 'undefined' })
  }
}`

/** WebKit, where createImageBitmap and image drawing are main-thread work (iOS Chrome and Firefox are WebKit too) */
export function isWebKit(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /AppleWebKit\//.test(ua) && !/(Chrome|Chromium|Edg|OPR)\//.test(ua)
}

interface Job {
  id: number
  blob: Blob
  resolve: (d: ImageData) => void
  reject: (e: Error) => void
}

class Pool {
  private workers: { w: Worker; job: Job | null }[] = []
  private queue: Job[] = []
  private nextId = 1
  broken = false

  constructor(size: number) {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }))
    for (let i = 0; i < size; i++) {
      const w = new Worker(url)
      const slot = { w, job: null as Job | null }
      w.onmessage = (e: MessageEvent) => {
        const job = slot.job
        slot.job = null
        if (job) {
          const { w: width, h, buf, error, fatal } = e.data
          if (fatal) this.fail()
          if (error || !buf) job.reject(new Error(error || 'decode failed'))
          else job.resolve(new ImageData(new Uint8ClampedArray(buf), width, h))
        }
        this.pump()
      }
      w.onerror = () => {
        const job = slot.job
        slot.job = null
        job?.reject(new Error('worker failed'))
        this.fail()
      }
      this.workers.push(slot)
    }
  }

  /** no OffscreenCanvas 2D in workers (Safari before 16.4): the caller decodes on the page instead */
  private fail() {
    this.broken = true
    for (const q of this.queue.splice(0)) q.reject(new Error('worker failed'))
  }

  decode(blob: Blob): Promise<ImageData> {
    if (this.broken) return Promise.reject(new Error('worker failed'))
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, blob, resolve, reject })
      this.pump()
    })
  }

  private pump() {
    for (const slot of this.workers) {
      if (slot.job || !this.queue.length) continue
      const job = this.queue.shift() as Job
      slot.job = job
      slot.w.postMessage({ id: job.id, blob: job.blob })
    }
  }
}

let pool: Pool | null = null

/** decode a frame to raw RGBA pixels off the main thread (size: workers, created once) */
export function decodeToPixels(blob: Blob, size: number): Promise<ImageData> {
  if (!pool) {
    try {
      pool = new Pool(size)
    } catch {
      return Promise.reject(new Error('no workers'))
    }
  }
  return pool.decode(blob)
}

export function pixelDecoderBroken(): boolean {
  return !!pool?.broken
}

/**
 * One GPU canvas per frame size holding the pixels of the frame last shown from it. A frame is copied in only when it
 * is the one to draw, and drawn from here every scrolled frame (a GPU-side copy).
 */
const stages = new Map<string, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; holds: ImageData | null }>()

export function isStaged(pixels: ImageData): boolean {
  return stages.get(`${pixels.width}x${pixels.height}`)?.holds === pixels
}

export function stagePixels(pixels: ImageData): HTMLCanvasElement {
  const key = `${pixels.width}x${pixels.height}`
  let s = stages.get(key)
  if (!s) {
    const canvas = Object.assign(document.createElement('canvas'), { width: pixels.width, height: pixels.height })
    s = { canvas, ctx: canvas.getContext('2d') as CanvasRenderingContext2D, holds: null }
    stages.set(key, s)
  }
  if (s.holds !== pixels) {
    s.ctx.putImageData(pixels, 0, 0)
    s.holds = pixels
  }
  return s.canvas
}
