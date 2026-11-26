'use client'

import { Component, Suspense, useEffect, type ReactNode } from 'react'
import { useGLTF } from '@react-three/drei'
import { PRODUCT } from '@/content/products'
import { useExperienceStore } from '@/state/experienceStore'
import { whenScrollIdle } from '@/motion/scrollIdle'
import { prepareProductScene } from './preparedScene'

/**
 * Parses the product model and builds its merged copy (mergeMeshes.ts) before the live canvas exists — neither needs
 * WebGL. On a phone these were the two longest tasks of the live model's set-up (traced at 4x CPU throttle: ~1 s parse,
 * ~0.5 s merge) and, run when the canvas mounted after the intro, they landed on the visitor's first swipes. Mounted by
 * ProductScene while scrolling is still locked (the intro's last, compositor-only phase) whenever the file has arrived
 * by then; otherwise at a pause in scrolling, with a deadline.
 *
 * Shares the loader cache with ProductModel (useGLTF): whichever asks first parses, the other waits for the same
 * result. If the canvas mounts first, ProductModel does the work as before — this never holds the model back.
 */
function Prepare() {
  const gltf = useGLTF(PRODUCT.model.source as string)
  useEffect(() => {
    const run = () => prepareProductScene(gltf)
    // still locked by the intro: nothing to interrupt
    if (useExperienceStore.getState().introPhase !== 'ready') {
      run()
      return
    }
    return whenScrollIdle(run, 1000)
  }, [gltf])
  return null
}

/** a failure here is left to the live model, which loads the same file and reports it (ProductRoot ModelBoundary) */
class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

export default function ModelPrep() {
  return (
    <Quiet>
      <Suspense fallback={null}>
        <Prepare />
      </Suspense>
    </Quiet>
  )
}
