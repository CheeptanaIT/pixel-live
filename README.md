<div align="center">

# 🎙️ Pixel Live

**ห้องพอดแคสต์ Pixel ในลิงก์เดียว** — ตั้งชื่อ สร้างห้อง ส่งลิงก์ให้เพื่อน แล้วคุยกันได้เลย
ตัวละคร Pixel Art ของแต่ละคนขยับปากตามเสียงที่พูด ไม่ต้องเปิดกล้อง ไม่ต้องติดตั้งโปรแกรม

[![Live](https://img.shields.io/badge/Live-pixel--live.cheeptana--boy.workers.dev-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://pixel-live.cheeptana-boy.workers.dev)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vite.dev)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Status](https://img.shields.io/badge/status-MVP-yellow?style=flat-square)]()

**[🌐 เปิดเว็บจริง](https://pixel-live.cheeptana-boy.workers.dev)** · **[📘 Dev Spec](docs/DEV_SPEC.md)**

</div>

---

## 📑 สารบัญ

- [สถานะโปรเจกต์](#-สถานะโปรเจกต์)
- [ความสามารถ](#-ความสามารถ)
- [สถาปัตยกรรม](#-สถาปัตยกรรม-ฟรี-ไม่มี-database)
- [Tech Stack](#-tech-stack)
- [พัฒนาในเครื่อง](#-พัฒนาในเครื่อง)
- [Deploy](#-deploy)

## 🚧 สถานะโปรเจกต์

กำลังพัฒนา (MVP) ฟีเจอร์หลักด้านล่างใช้งานได้แล้ว

## ✨ ความสามารถ

| หมวด | รายละเอียด |
|------|-----------|
| 🏠 **ห้อง** | สร้างห้อง + ลิงก์เชิญ เสียงแบบ P2P สูงสุด 10 คน |
| 🎭 **เวที Pixel** | ตัวละครขยับปากตามเสียง อัปรูปตัวเองแล้วแปลงเป็น Pixel Art (แชร์ให้ทุกคนแบบ P2P) |
| 👑 **Host** | ล็อกห้อง / เตะคนออก / เปลี่ยนฉากหลังให้ทุกคน (ฉากสำเร็จรูป 4 แบบ หรืออัปรูปเอง) |
| 📺 **ไลฟ์** | Host คัดลอกลิงก์ "ไลฟ์ผ่าน OBS" ไปวางเป็น Browser Source ใน OBS (มีโหมดพื้นหลังโปร่งใส) ไลฟ์ได้ทุกแพลตฟอร์มผ่าน OBS |
| 😀 **อีโมต** | 4 แบบ (กดปุ่ม `1`–`4` หรือกดบนจอ) ลอยเหนือหัวตัวละคร ทุกคนและหน้า OBS เห็น |
| ⏱️ **ไทม์ไลน์** | Host จับเวลา กด `B` ทำ Bookmark แล้วส่งออก `timeline.csv`, `markers.json` และข้อความ YouTube Chapters (เก็บในเครื่อง ไม่ส่งไป server) |
| 🎤 **ล็อบบี้** | ปุ่มทดสอบไมค์ (แถบวัดระดับเสียง) |
| 🔁 **TURN (relay)** | เป็นตัวเลือกที่**ปิดไว้ก่อน** เพราะเกิน 1,000 GB/เดือนจะคิดเงิน เปิดทีหลังได้ด้วยการตั้ง key และ `TURN_ENABLED` (ดูหัวข้อ TURN ใน [docs/DEV_SPEC.md](docs/DEV_SPEC.md)) |

## 🏗️ สถาปัตยกรรม (ฟรี ไม่มี database)

```
 ผู้ใช้ A ◄──── เสียง WebRTC (P2P mesh) ────► ผู้ใช้ B
    │                                            │
    └──────► Cloudflare Worker + Durable ◄───────┘
              Object  (ส่งต่อ signaling เท่านั้น)
```

- เสียงวิ่งตรงระหว่างผู้ใช้ (WebRTC mesh) ไม่ผ่านเซิร์ฟเวอร์
- เซิร์ฟเวอร์คือ Cloudflare Worker + Durable Object ตัวเดียว ทำหน้าที่ส่งต่อข้อความ signaling เท่านั้น ไม่เก็บข้อมูลอะไรเลย
- สิทธิ์ Host พิสูจน์ด้วย `roomId = hash(hostKey)` โดย `hostKey` อยู่ในเบราว์เซอร์ของ Host เท่านั้น

## 🛠️ Tech Stack

| ส่วน | เทคโนโลยี |
|------|-----------|
| Frontend | React 19 · TypeScript · Vite · Tailwind CSS 4 |
| Graphics / State | PixiJS 8 · Zustand |
| Validation | Valibot |
| Backend | Cloudflare Workers + Durable Objects (SQLite) |
| Test | Vitest (รวมรันใน workerd จริง) · Playwright (E2E) |

## 💻 พัฒนาในเครื่อง

ต้องมี **Node 22+**

```bash
npm install
npm run dev          # http://localhost:5173 (Worker + Durable Object ทำงานในเครื่อง)
npm test             # unit test + ทดสอบ Worker ในรันไทม์ workerd จริง
npx playwright install chromium
npm run test:e2e     # ทดสอบผ่านเบราว์เซอร์จริง (ใช้ไมค์ปลอมของ Chromium)
```

> 💡 ตอน `npm run dev` เปิด `/dev/stage?n=6` เพื่อดูเวทีกับตัวละครปลอมโดยไม่ต้องใช้ไมค์ (มีเฉพาะโหมด dev)

## 🚀 Deploy

```bash
npx wrangler login
npm run deploy
```

ใช้แพ็กเกจฟรีของ Cloudflare ได้ (Durable Object ต้องเป็นแบบ SQLite ตามที่ตั้งไว้ใน `wrangler.jsonc`)
