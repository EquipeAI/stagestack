const SUPPORTED_HEADSHOT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function isSupportedHeadshot(file: File): boolean {
  return SUPPORTED_HEADSHOT_TYPES.has(file.type.trim().toLowerCase())
}

function validatedOrigin(value: string, label: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid URL.`)
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new Error(`${label} must be an HTTP(S) origin without a path.`)
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${label} must use HTTPS outside local development.`)
  }
  return url
}

export function resolveConvexSiteUrl(args: {
  convexUrl: string
  convexSiteUrl?: string
}): string {
  const explicit = args.convexSiteUrl?.trim()
  if (explicit !== undefined && explicit !== '') {
    return validatedOrigin(explicit, 'VITE_CONVEX_SITE_URL').origin
  }
  const deployment = validatedOrigin(args.convexUrl, 'VITE_CONVEX_URL')
  if (
    deployment.hostname.endsWith('.convex.cloud') &&
    deployment.hostname !== 'convex.cloud'
  ) {
    deployment.hostname = deployment.hostname.replace(
      /\.convex\.cloud$/,
      '.convex.site',
    )
    return deployment.origin
  }
  if (LOOPBACK_HOSTS.has(deployment.hostname) && deployment.port !== '') {
    deployment.port = String(Number(deployment.port) + 1)
    return deployment.origin
  }
  throw new Error(
    'Set VITE_CONVEX_SITE_URL for a custom Convex HTTP action origin.',
  )
}

export async function uploadHeadshot(args: {
  convexUrl: string
  convexSiteUrl?: string
  uploadId: string
  token: string
  file: File
}): Promise<void> {
  const response = await fetch(
    `${resolveConvexSiteUrl(args)}/api/headshots/${encodeURIComponent(args.uploadId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.token}`,
        'Content-Type': args.file.type,
      },
      body: args.file,
    },
  )
  if (response.ok) return
  let message = 'That photo could not be uploaded.'
  try {
    const body: unknown = await response.json()
    if (
      body !== null &&
      typeof body === 'object' &&
      typeof (body as { error?: unknown }).error === 'string'
    ) {
      message = (body as { error: string }).error
    }
  } catch {
    // Keep the stable fallback when a proxy returns a non-JSON failure.
  }
  throw new Error(message)
}
