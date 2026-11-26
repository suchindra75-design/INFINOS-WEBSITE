import type * as THREE from 'three'
import { PRODUCT } from '@/content/products'
import { mergePartMeshes } from './mergeMeshes'

/**
 * The product's private, merged copy of the model (mergeMeshes.ts), built ahead of time by ModelPrep. Handed out once:
 * the live model rearranges the copy's nodes into its own groups, so a second mount (a remount after a lost WebGL
 * context, React StrictMode in development) builds a fresh one.
 */
const ready = new WeakMap<object, THREE.Object3D>()
/** the live model already has its copy: building another ahead of time would be wasted work */
const taken = new WeakSet<object>()

function build(gltf: { scene: THREE.Object3D }): THREE.Object3D {
  const c = gltf.scene.clone(true)
  const { before, after } = mergePartMeshes(c, PRODUCT.modelComponents.map((s) => s.nodeName))
  if (process.env.NODE_ENV !== 'production') console.info(`[product] draws per pass: ${before} -> ${after}`)
  return c
}

export function prepareProductScene(gltf: { scene: THREE.Object3D }) {
  if (!ready.has(gltf) && !taken.has(gltf)) ready.set(gltf, build(gltf))
}

export function takeProductScene(gltf: { scene: THREE.Object3D }): THREE.Object3D {
  taken.add(gltf)
  const c = ready.get(gltf)
  if (c) {
    ready.delete(gltf)
    return c
  }
  return build(gltf)
}

export const isProductScenePrepared = (gltf: { scene: THREE.Object3D }) => ready.has(gltf)
