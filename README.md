# Pixel Live

ห้องพอดแคสต์ Pixel ในลิงก์เดียว: ตั้งชื่อ สร้างห้อง ส่งลิงก์ให้เพื่อน แล้วคุยกันได้เลย ตัวละคร Pixel Art ของแต่ละคนขยับปากตามเสียงที่พูด (ไม่ต้องเปิดกล้อง ไม่ต้องติดตั้งโปรแกรม)

**เว็บจริง:** https://pixel-live.cheeptana-boy.workers.dev

> สถานะ: กำลังพัฒนา (MVP) ตอนนี้ทำได้แล้ว: ห้อง + ลิงก์เชิญ, เสียงแบบ P2P สูงสุด 10 คน, เวที Pixel พร้อมตัวละครที่ขยับตามเสียง, อัปรูปตัวเองแล้วแปลงเป็น Pixel Art (แชร์ให้ทุกคนแบบ P2P), Host ล็อกห้อง/เตะคนได้และเปลี่ยนฉากหลังให้ทุกคน (ฉากสำเร็จรูป 4 แบบ หรืออัปรูปเอง)
> ไลฟ์: Host คัดลอกลิงก์ "ไลฟ์ผ่าน OBS" ในห้องไปวางเป็น Browser Source ใน OBS (มีโหมดพื้นหลังโปร่งใส) แล้วไลฟ์ได้ทุกแพลตฟอร์มผ่าน OBS
> อีโมต 4 แบบ (กดปุ่ม 1–4 หรือกดปุ่มบนจอ) ลอยเหนือหัวตัวละครให้ทุกคนและหน้า OBS เห็น
> ยังไม่มี: บันทึกไทม์ไลน์ (ดูแผนใน [docs/DEV_SPEC.md](docs/DEV_SPEC.md))

## ออกแบบให้ใช้งานฟรี ไม่มี database

- เสียงวิ่งตรงระหว่างผู้ใช้ (WebRTC mesh) ไม่ผ่านเซิร์ฟเวอร์
- เซิร์ฟเวอร์คือ Cloudflare Worker + Durable Object ตัวเดียว ทำหน้าที่ส่งต่อข้อความ signaling เท่านั้น ไม่เก็บข้อมูลอะไรเลย
- สิทธิ์ Host พิสูจน์ด้วย `roomId = hash(hostKey)` โดย `hostKey` อยู่ในเบราว์เซอร์ของ Host เท่านั้น

## พัฒนาในเครื่อง

ต้องมี Node 22+

```bash
npm install
npm run dev          # http://localhost:5173 (Worker + Durable Object ทำงานในเครื่อง)
npm test             # unit test + ทดสอบ Worker ในรันไทม์ workerd จริง
npx playwright install chromium
npm run test:e2e     # ทดสอบผ่านเบราว์เซอร์จริง (ใช้ไมค์ปลอมของ Chromium)
```

ตอน `npm run dev` เปิด `/dev/stage?n=6` เพื่อดูเวทีกับตัวละครปลอมโดยไม่ต้องใช้ไมค์ (มีเฉพาะโหมด dev)

## Deploy

```bash
npx wrangler login
npm run deploy
```

ใช้แพ็กเกจฟรีของ Cloudflare ได้ (Durable Object ต้องเป็นแบบ SQLite ตามที่ตั้งไว้ใน `wrangler.jsonc`)
