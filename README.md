# ChargeLog — คู่มือติดตั้ง (Windows)

## สิ่งที่ต้องเตรียม (ฟรีทั้งหมด)
- Node.js: https://nodejs.org (กด LTS)
- บัญชี GitHub: https://github.com
- บัญชี Supabase: https://supabase.com
- บัญชี Vercel: https://vercel.com

---

## ขั้นตอนที่ 1 — ติดตั้ง Node.js
1. เปิด https://nodejs.org แล้วกด "LTS" ดาวน์โหลด
2. ดับเบิลคลิกไฟล์ที่โหลดมา ติดตั้งตามปกติ กด Next ไปเรื่อยๆ
3. เปิด PowerShell → พิมพ์ `node -v` ถ้าขึ้นเลขเวอร์ชันแปลว่าสำเร็จ

---

## ขั้นตอนที่ 2 — ตั้งค่า Supabase
1. เข้า https://supabase.com → Sign up (ใช้ Google ได้)
2. กด "New project" → ตั้งชื่อ chargelog → Region: Singapore → Create project
3. รอ ~2 นาที จนหน้า Dashboard โหลดเสร็จ
4. กด "SQL Editor" ในแถบซ้าย → กด "New query"
5. เปิดไฟล์ `supabase_setup.sql` ในโฟลเดอร์นี้ → Copy ทั้งหมด → Paste ใน SQL Editor → กด Run
6. ไปที่ Settings → API → คัดลอก:
   - Project URL (เช่น https://abcdef.supabase.co)
   - anon / public key (ยาวมาก)

---

## ขั้นตอนที่ 3 — ใส่ค่า Supabase ในโค้ด
1. เปิดไฟล์ `src/supabase.js` ด้วย Notepad หรือ VS Code
2. แทนที่ `PASTE_YOUR_PROJECT_URL_HERE` ด้วย Project URL ของคุณ
3. แทนที่ `PASTE_YOUR_ANON_KEY_HERE` ด้วย anon key ของคุณ
4. บันทึกไฟล์

---

## ขั้นตอนที่ 4 — รันแอปในเครื่อง (ทดสอบก่อน)
1. เปิด PowerShell → cd ไปที่โฟลเดอร์ chargelog
   ```
   cd C:\Users\YourName\Desktop\chargelog
   ```
2. รัน:
   ```
   npm install
   npm run dev
   ```
3. เปิดเบราว์เซอร์ไปที่ http://localhost:3000
4. ทดสอบแอปว่าทำงานได้ปกติ

---

## ขั้นตอนที่ 5 — อัปโหลดขึ้น GitHub
1. สมัคร https://github.com → สร้าง Repository ชื่อ chargelog (Public)
2. ดาวน์โหลด Git: https://git-scm.com/download/win → ติดตั้ง
3. เปิด PowerShell ในโฟลเดอร์ chargelog แล้วรัน:
   ```
   git init
   git add .
   git commit -m "initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/chargelog.git
   git push -u origin main
   ```
   (แทน YOUR_USERNAME ด้วยชื่อ GitHub ของคุณ)

---

## ขั้นตอนที่ 6 — Deploy บน Vercel
1. เข้า https://vercel.com → Sign up with GitHub
2. กด "Add New Project" → เลือก repo "chargelog"
3. Framework Preset จะตรวจพบเป็น Vite อัตโนมัติ
4. กด Deploy → รอ ~1 นาที
5. จะได้ URL เช่น https://chargelog-xxx.vercel.app

---

## ขั้นตอนที่ 7 — ติดตั้งเป็นแอปบน Android
1. เปิด Chrome บน Android
2. เข้า URL ของ Vercel ที่ได้
3. กดเมนู 3 จุด (มุมบนขวา)
4. กด "เพิ่มลงในหน้าจอหลัก" (Add to Home screen)
5. ตั้งชื่อ ChargeLog → กดเพิ่ม
6. จะได้ไอคอนบนหน้าจอ เปิดได้เต็มจอเหมือนแอปจริง ✓

---

## หากต้องการอัปเดตแอปในอนาคต
แก้ไขโค้ด → รัน git add . && git commit -m "update" && git push
Vercel จะ deploy อัตโนมัติภายใน 1 นาที
