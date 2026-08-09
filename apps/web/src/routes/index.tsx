import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { Show, SignInButton, UserButton } from '@clerk/tanstack-react-start'
import { api } from '@convex/_generated/api'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  const viewer = useQuery(api.auth.viewer)
  return (
    <main className="mx-auto max-w-2xl p-8 space-y-6">
      <h1 className="text-3xl font-bold">StageStack</h1>
      <p className="text-neutral-500">
        Open source speaker &amp; content management for events.
      </p>
      <div className="flex items-center gap-4">
        <Show when="signed-out">
          <SignInButton mode="modal">
            <button className="rounded bg-black px-4 py-2 text-white">
              Sign in
            </button>
          </SignInButton>
        </Show>
        <Show when="signed-in">
          <UserButton />
        </Show>
      </div>
      <section className="rounded border p-4 text-sm">
        <h2 className="mb-2 font-semibold">Auth round-trip (walking skeleton)</h2>
        {viewer === undefined ? (
          <p>Loading…</p>
        ) : viewer === null ? (
          <p>Convex sees you as: anonymous</p>
        ) : (
          <p>
            Convex sees you as: {viewer.name ?? viewer.subject}
            {viewer.email ? ` (${viewer.email})` : null}
          </p>
        )}
      </section>
    </main>
  )
}
