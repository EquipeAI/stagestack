import { afterEach, describe, expect, test, vi } from 'vitest'
import { resolveConvexSiteUrl, uploadHeadshot } from './headshotUpload'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('uploadHeadshot', () => {
  test('posts the ticketed bytes to convex.site with the Clerk bearer token', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['png'], 'speaker.png', { type: 'image/png' })

    await uploadHeadshot({
      convexUrl: 'https://example.convex.cloud',
      convexSiteUrl: 'https://uploads.example.test',
      uploadId: 'ticket-id',
      token: 'signed-convex-jwt',
      file,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://uploads.example.test/api/headshots/ticket-id',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer signed-convex-jwt',
          'Content-Type': 'image/png',
        },
        body: file,
      }),
    )
  })

  test('derives only standard cloud/local site origins and requires custom configuration', () => {
    expect(
      resolveConvexSiteUrl({
        convexUrl: 'https://example.convex.cloud',
      }),
    ).toBe('https://example.convex.site')
    expect(
      resolveConvexSiteUrl({ convexUrl: 'http://127.0.0.1:3210' }),
    ).toBe('http://127.0.0.1:3211')
    expect(() =>
      resolveConvexSiteUrl({ convexUrl: 'https://custom.example.test' }),
    ).toThrow('VITE_CONVEX_SITE_URL')
    expect(() =>
      resolveConvexSiteUrl({
        convexUrl: 'https://example.convex.cloud',
        convexSiteUrl: 'javascript:alert(1)',
      }),
    ).toThrow('HTTP(S) origin')
    expect(() =>
      resolveConvexSiteUrl({
        convexUrl: 'https://example.convex.cloud',
        convexSiteUrl: 'http://uploads.example.test',
      }),
    ).toThrow('must use HTTPS')
  })

  test('surfaces the safe server error without expecting a storage id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Image bytes did not match.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const file = new File(['bad'], 'speaker.png', { type: 'image/png' })

    await expect(
      uploadHeadshot({
        convexUrl: 'https://example.convex.cloud',
        uploadId: 'ticket-id',
        token: 'signed-convex-jwt',
        file,
      }),
    ).rejects.toThrow('Image bytes did not match.')
  })
})
