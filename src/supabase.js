import { createClient } from '@supabase/supabase-js'

// ใส่ค่าจาก Supabase Dashboard → Settings → API
const SUPABASE_URL = 'https://rygpajoprmygfxfqjbol.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ5Z3Bham9wcm15Z2Z4ZnFqYm9sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MDA1MDgsImV4cCI6MjA5ODQ3NjUwOH0.oHyIVKFC9x4JHrSsxswIsyhcnT55ehrEUxYRrG2vVwM'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// สร้าง user_id ถาวรสำหรับเครื่องนี้ (เก็บใน localStorage)
export const getUserId = () => {
  let id = localStorage.getItem('chargelog_uid')
  if (!id) {
    id = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    localStorage.setItem('chargelog_uid', id)
  }
  return id
}
