import { auth, clerkClient } from '@clerk/nextjs/server'

// Directory of all Clerk users (id -> name/email) for the admin portal.
// Access requires a row in public.admins — verified against Supabase using the
// caller's own session token, so RLS is the single source of truth.
export async function GET() {
  const { userId, getToken } = await auth()
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const token = await getToken()
  const check = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/admins?select=user_id&user_id=eq.${userId}`,
    { headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }, cache: 'no-store' }
  )
  const rows = check.ok ? await check.json() : []
  if (!rows.length) return Response.json({ error: 'forbidden' }, { status: 403 })

  const client = await clerkClient()
  const { data } = await client.users.getUserList({ limit: 200, orderBy: '-created_at' })
  return Response.json({
    users: data.map((u) => ({
      id: u.id,
      name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || '—',
      email: u.primaryEmailAddress?.emailAddress || u.emailAddresses?.[0]?.emailAddress || '',
      image: u.imageUrl,
      created: u.createdAt,
      lastActive: u.lastActiveAt,
    })),
  })
}
