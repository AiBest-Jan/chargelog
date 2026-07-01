import { createClient } from '@supabase/supabase-js'

// ใส่ค่าจาก Supabase Dashboard → Settings → API Keys
const SUPABASE_URL = 'https://rygpajoprmygfxfqjbol.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ5Z3Bham9wcm15Z2Z4ZnFqYm9sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MDA1MDgsImV4cCI6MjA5ODQ3NjUwOH0.oHyIVKFC9x4JHrSsxswIsyhcnT55ehrEUxYRrG2vVwM'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// Login ด้วย Google
export const signInWithGoogle = async () => {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: 'https://chargelog-ai-best.vercel.app',
    },
  })
  if (error) console.error('Login error:', error)
}

// Logout
export const signOut = async () => {
  await supabase.auth.signOut()
}

// ดึง session ปัจจุบัน
export const getSession = async () => {
  const { data: { session } } = await supabase.auth.getSession()
  return session
}
