import { PRODUCT } from '@/content/products'

/**
 * Downloads the product model's file into the browser's HTTP cache, without parsing it (no three.js on this path, so
 * the page's first JavaScript stays small). The parse later reads it from the cache (ModelPrep / ProductModel).
 *
 * Started once the opening frames are in (ProductScene): on a mobile connection the 4 MB file must not compete with the
 * few frames the intro is waiting for (an earlier prefetch during the logo did, and delayed the intro).
 */
let download: Promise<boolean> | null = null
export function downloadModelBytes(): Promise<boolean> {
  const src = PRODUCT.model.source
  if (!src) return Promise.resolve(false)
  if (!download) {
    download = fetch(src)
      .then((r) => (r.ok ? r.arrayBuffer().then(() => true) : false))
      .catch(() => false)
  }
  return download
}
