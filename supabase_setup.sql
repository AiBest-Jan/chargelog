-- วาง SQL นี้ใน Supabase SQL Editor แล้วกด Run

-- ตาราง sessions (บันทึกการชาร์จแต่ละครั้ง)
create table if not exists sessions (
  id            text primary key,
  user_id       text not null,
  datetime      text,
  vehicle_id    text,
  charge_type   text default 'AC',
  location      text,
  odometer      numeric,
  kwh           numeric,
  price_per_unit numeric,
  total_cost    numeric,
  start_percent  numeric,
  end_percent    numeric,
  efficiency    numeric,
  note          text,
  created_at    timestamp with time zone default now()
);

-- ตาราง user_settings (เก็บการตั้งค่าและข้อมูลรถ)
create table if not exists user_settings (
  user_id    text primary key,
  data       jsonb,
  updated_at timestamp with time zone default now()
);

-- เปิด Row Level Security (ความปลอดภัย)
alter table sessions enable row level security;
alter table user_settings enable row level security;

-- Policy: ให้เข้าถึงได้เลย (แอปส่วนตัว ไม่ต้อง login)
create policy "allow all sessions"
  on sessions for all
  using (true)
  with check (true);

create policy "allow all settings"
  on user_settings for all
  using (true)
  with check (true);

-- Index เพื่อให้ query เร็วขึ้น
create index if not exists idx_sessions_user_id on sessions(user_id);
create index if not exists idx_sessions_datetime on sessions(user_id, datetime);
