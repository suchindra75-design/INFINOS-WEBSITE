/**
 * The scroll frames and 3D models are large files with fixed names. Served with Vercel's default for public files
 * (max-age=0, must-revalidate), a returning visitor's phone re-checked every frame and the 4 MB model with the server
 * before it could use its own copy. They are now used straight from the browser cache for a day, and after that shown
 * from the cache while a fresh copy is fetched in the background — so an updated model or frame set reaches visitors
 * within a day.
 */
const ASSET_CACHE = 'public, max-age=86400, stale-while-revalidate=2592000'

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return ['/sequences/:path*', '/models/:path*'].map((source) => ({
      source,
      headers: [{ key: 'Cache-Control', value: ASSET_CACHE }],
    }))
  },
}

export default nextConfig
