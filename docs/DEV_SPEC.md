# Pixel Live — Dev Spec (MVP)

> ห้องพอดแคสต์ Pixel ในลิงก์เดียว: อัป PNG 2 รูป → ส่งลิงก์ → คุยกัน ตัวละครขยับตามเสียง → เอา URL ไปวางใน OBS แล้วไลฟ์
>
> ข้อจำกัดหลัก: **ค่าใช้จ่าย 0 บาท**, ไม่มีเครื่อง host, deploy บน cloud ฟรี

---

## 1. Tech Stack

| ส่วน | เลือก | เหตุผล |
|---|---|---|
| Frontend | **Vite + React + TypeScript** | เป็น SPA ล้วน ไม่ต้องใช้ SSR (Next.js `output: export` ทำ dynamic route `/r/:id` ไม่ได้) |
| Styling | TailwindCSS v4 | ตาม SRS |
| State | zustand | เล็กและเรียบง่าย |
| Canvas | **Pixi.js v8** (+ `pixi.js/gif` สำหรับฉาก GIF) | ตาม SRS |
| Realtime media | **WebRTC P2P Mesh (เฉพาะ audio)** | ไม่ต้องใช้ SFU จึงไม่มีค่าใช้จ่าย |
| Signaling | **Cloudflare Worker + Durable Object** (1 ห้อง = 1 DO) ทำหน้าที่ relay อย่างเดียว | ฟรี ไม่หลับ ใช้ WebSocket Hibernation ได้ |
| Database / Storage | **ไม่มี** sprite และฉากส่งตรงระหว่าง peer ผ่าน WebRTC data channel | server ไม่เก็บข้อมูลผู้ใช้ จึงไม่มีอะไรต้องลบและไม่มีโควตา storage ให้กังวล |
| Hosting | **Workers Static Assets** (frontend + API อยู่ใน Worker เดียว) | same-origin ไม่มี CORS และ deploy ครั้งเดียวได้ทั้งระบบ |
| Validation | valibot (ใช้ใน shared protocol) | ขนาดเล็ก ใช้ได้ทั้ง worker และ client |
| Test | vitest, `@cloudflare/vitest-pool-workers`, Playwright (fake media) | |
| Dev tooling | `@cloudflare/vite-plugin` | รัน Worker + DO ใน `vite dev` เครื่องเดียวได้ |

ต้องมี Node 22+, บัญชี Cloudflare แบบฟรี และ GitHub repo

---

## 2. โครงสร้างโปรเจกต์

```
pixel-live/
├─ package.json
├─ vite.config.ts            # react() + cloudflare()
├─ wrangler.jsonc            # assets SPA mode + DO binding + migrations
├─ shared/
│  └─ protocol.ts            # message types + valibot schemas (client & worker ใช้ร่วม)
├─ worker/
│  ├─ index.ts               # router: /ws/:roomId → RoomDO, ส่วนอื่นให้ static assets
│  └─ room.ts                # class RoomDO (Hibernation WebSocket, relay อย่างเดียว)
├─ src/
│  ├─ main.tsx, App.tsx
│  ├─ routes/  Home.tsx  Room.tsx  Stage.tsx
│  ├─ net/     signaling.ts (WS + reconnect)  mesh.ts  peer.ts (perfect negotiation)
│  │           channel.ts (data channel: control + ส่งไฟล์เป็น chunk)
│  ├─ audio/   mic.ts  vad.ts  playback.ts
│  ├─ stage/   StageRenderer.ts  layout.ts  avatar.ts  outline.ts  emotes.ts
│  │           pixelize.ts  procedural.ts  text.ts
│  ├─ session/ timeline.ts  export.ts
│  ├─ store/   room.ts  me.ts
│  └─ ui/      ปุ่ม/panel ธีม retro
└─ public/assets/  bg/  emotes/  fonts/
```

---

## 3. Routes

| Path | หน้าที่ |
|---|---|
| `/` | หน้าแรก: ตั้งชื่อ + avatar, ปุ่ม "สร้างห้อง" |
| `/r/:roomId` | ห้อง (ทั้ง host และ guest) ลิงก์นี้ใช้เป็น invite link ได้เลย |
| `/s/:roomId?transparent=1` | Stage สำหรับ OBS แสดงเฉพาะ canvas และรับเสียงอย่างเดียว |
| `GET /ws/:roomId` | WebSocket upgrade แล้วส่งต่อให้ RoomDO (เป็น endpoint เดียวของ server) |

**สร้างห้องฝั่ง client โดยไม่ต้องเรียก API และไม่ต้องเก็บ state:**
- `hostKey` = random 32 bytes สร้างใน browser แล้วเก็บใน localStorage
- `roomId` = base58( SHA-256(hostKey) ) เอา **16 ตัวท้าย** (~94 bit) ไม่ใช่ 10 ตัว เพราะ roomId อยู่ในลิงก์เชิญซึ่งเป็นสาธารณะ ถ้าสั้นเกินไปอาจมีคนลองสุ่ม hostKey จนได้ roomId ตรงแล้วยึดสิทธิ์ host ได้
- DO ตรวจว่าเป็น host หรือไม่โดย hash `hostKey` ที่ส่งมาแล้วเทียบกับ `roomId` ไม่ต้องจำอะไรไว้เลย เพราะคนที่ไม่มี key ปลอมเป็น host ไม่ได้
- ห้องมีอยู่ตราบที่ยังมีคนเชื่อมต่ออยู่ Host เปิดลิงก์เดิมซ้ำวันไหนก็ได้ จะได้ห้องเดิมพร้อมสิทธิ์ host เดิม
- ไม่มี stageKey เพราะ stage เป็นผู้ฟังที่รับอย่างเดียว คนที่มีลิงก์เชิญก็ฟังได้อยู่แล้ว

---

## 4. Signaling Protocol (WebSocket, JSON)

ทุกข้อความต้องผ่าน valibot schema ใน `shared/protocol.ts` ขนาดไม่เกิน 64 KB

**Client → Server**
```ts
{ t: 'hello', peerId, name, role: 'speaker'|'stage', hostKey? }
{ t: 'signal', to, data: { sdp } | { candidate } }
{ t: 'kick', peerId }                          // ต้องเป็น host
{ t: 'lock', locked }                          // ต้องเป็น host
```

**Server → Client**
```ts
{ t: 'welcome', you: Peer, locked, peers: Peer[] }   // Peer = { peerId, name, role, isHost }
{ t: 'join', peer } | { t: 'leave', peerId }
{ t: 'lock', locked }
{ t: 'signal', from, data }
{ t: 'error', code: 'FULL'|'LOCKED'|'KICKED'|'REPLACED'|'BAD_ROOM'|'BAD_KEY'|'BAD_MESSAGE'|'FORBIDDEN' }
```
- `isHost` อยู่ใน Peer เลย จึงไม่มี `hostId` แยก (host เปิดสองแท็บก็เป็น host ทั้งคู่ได้)
- **Close code ≥ 4000 = จบถาวร client ห้าม reconnect:** `4000 REPLACED`, `4001 REJECTED` (เต็ม/ล็อก/key ผิด/ข้อความเสีย), `4002 KICKED` ส่วนโค้ดอื่นให้ reconnect แบบ backoff แบบสุ่มเวลา

**RoomDO: relay ล้วน ไม่ใช้ storage API**
- ใช้ `ctx.acceptWebSocket(ws)` และเก็บ `{roomId, peer?, locked}` ด้วย `serializeAttachment` ทำให้ state รอดหลัง hibernate โดยไม่ต้องลงดิสก์ (`peer` ว่างจนกว่าจะ hello สำเร็จ)
- ค้นหาผู้รับด้วยการวนอ่าน attachment ของ `ctx.getWebSockets()` (ห้องมีไม่เกิน 12 socket)
- จำกัด speaker ไม่เกิน 10 และ stage ไม่เกิน 2 ส่วน host ที่ถูกล็อกห้องยังเข้าได้ คนอื่นรวมถึง stage เข้าไม่ได้
- ถ้าต่อใหม่ด้วย `peerId` เดิม (เก็บใน sessionStorage) ให้ evict socket เก่าด้วย `REPLACED` แล้ว broadcast `leave` ตามด้วย `join` เพื่อให้ทุกคนสร้าง RTCPeerConnection ใหม่ได้
- ตรวจ hostKey แล้ว **await** แปลว่าข้อความอื่นแทรกได้ ดังนั้นการเช็กความจุกับการเขียน attachment ต้องอยู่ในช่วงโค้ด synchronous ช่วงเดียวกัน
- socket ที่ส่งข้อความเสียก่อน hello จะถูกปิด แต่ peer ที่ hello แล้วจะได้แค่ `BAD_MESSAGE` โดยไม่ถูกตัด
- เมื่อ socket สุดท้ายหลุด state ทั้งหมดหายไปพร้อม DO ไม่ต้องตั้ง alarm หรือ cleanup ใดๆ
- ยังไม่มี rate limit ต่อ socket (ตกไป M9)

**Data channel `ctl` (reliable, ordered) สร้างใน RTCPeerConnection ทุกคู่**
```ts
{ t: 'profile', name, threshold, avatar: { idle, talk, blink? } }  // sha256 ของแต่ละรูป
{ t: 'want', sha }                    // ขอไฟล์ที่ยังไม่มีใน cache
{ t: 'file', sha, seq, total, chunk } // chunk ขนาด 16 KB (ArrayBuffer)
{ t: 'emote', id: 1|2|3|4 }
{ t: 'scene', bg: 'builtin:radio' | sha }   // ส่งจาก host เท่านั้น
```
- ผู้รับต้องเช็กว่า `scene` มาจาก peer ที่ server ประกาศ `isHost: true` ไว้ ถ้าไม่ใช่ให้ทิ้ง
- emote ส่งผ่าน P2P จึงเร็วกว่าการวิ่งผ่าน server และไม่กินโควตา DO

---

## 5. WebRTC Mesh

- 1 คู่ peer = 1 `RTCPeerConnection` ใช้ audio transceiver อย่างเดียว (stage ใช้ `recvonly`)
- **คนที่เพิ่งเข้าห้องเป็นฝ่ายส่ง offer แรกเสมอ** (ฝั่งที่ได้ `welcome` = initiator ส่วนคนที่อยู่ในห้องแล้วและได้ `join` = รอตอบอย่างเดียว) ห้ามให้ทั้งสองฝั่งส่ง offer พร้อมกัน เพราะฝั่ง polite ต้อง rollback แล้ว Chrome บางครั้งไม่สร้าง ICE candidate ต่อ ทำให้ link ค้างที่ "connecting" (เจอจริงราว 1 ใน 20 ครั้ง และห้อง 6 คนล้มแทบทุกครั้ง)
- ยังคง **Perfect Negotiation** (ฝั่งที่ `peerId` น้อยกว่าเป็น polite) ไว้เป็นตาข่ายนิรภัยสำหรับกรณีชนกันตอน `restartIce`
- ประมวลผล signal ของแต่ละ link **ทีละข้อความตามลำดับ** (คิว) ไม่งั้น ICE candidate อาจมาถึง `addIceCandidate` ก่อนที่ description ของมันจะถูกตั้งเสร็จ
- ข้อมูลใน `signal` ผ่าน relay โดยไม่ถูกตรวจ ผู้รับต้อง validate เองด้วย `SignalData` schema
- **data channel `ctl` ยังไม่ทำใน M2** เลื่อนไปทำตอน M4/M6 ที่ต้องใช้จริง (เพิ่มทีหลังไม่ต้องแก้ส่วนเสียง)
- หลัง WebSocket ของเราหลุดแล้วต่อใหม่ ให้ทิ้ง link ทั้งหมดแล้วสร้างใหม่ตาม `welcome` เพราะคนอื่นถูกบอกว่าเรา leave แล้วทิ้งฝั่งของเขาไปแล้ว
- ICE: STUN `stun.cloudflare.com:3478`; TURN (Cloudflare Realtime, ฟรี 1,000 GB/เดือน) ทำในงาน M9 โดย Worker ขอ credential อายุสั้นให้
- `iceconnectionstatechange` = `failed` ให้เรียก `pc.restartIce()`
- Mic: `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`
- จำกัด bitrate ด้วย `sender.setParameters({ encodings: [{ maxBitrate: 32000 }] })` ห้อง 10 คนจะใช้ upload ราว 300 kbps

**กับดักที่รู้อยู่แล้ว**
- Chrome: remote stream ต้องผูกกับ `<audio>` element ด้วย ไม่อย่างนั้น `MediaStreamSource` ใน WebAudio จะอ่านได้แต่ค่าศูนย์
- Autoplay: ต้องให้ผู้ใช้กดปุ่ม "เข้าห้อง" ก่อนสร้าง AudioContext และเล่นเสียง ส่วน OBS ไม่ติดเรื่องนี้

---

## 6. Voice Activity Detection (VAD)

- **คำนวณฝั่งผู้รับ** จาก audio ที่ได้รับจริง ทำให้ lip-sync ตรงกับเสียงที่ได้ยินเสมอ เพราะผ่าน jitter buffer ตัวเดียวกัน
- แต่ละ track ใช้ `AnalyserNode` (`fftSize 512`) แล้วคำนวณ RMS → dBFS ใน Pixi ticker ทุกเฟรม
- Hysteresis: เปิดเมื่อมากกว่า `threshold` และปิดเมื่อน้อยกว่า `threshold - 6dB` ต่อเนื่องเกิน `hold` 180 ms
- `threshold` ค่าเริ่มต้นคือ -45 dBFS **(M3 ใช้ค่านี้ค่าเดียวกันทุกคน)** ส่วนการปรับ sensitivity เองแล้ว broadcast ผ่าน data channel (`profile`) เลื่อนไป M4/M9
- ส่ง event `speaking-start/stop(peerId, t)` ไปให้ทั้ง renderer และ timeline (ฝั่ง timeline ทำใน M8)
- **onset ไม่มี attack delay** (ข้ามเกณฑ์แล้วเป็น speaking ในอัปเดตเดียวกัน) มีเฉพาะ release ที่หน่วง จึงเหลือความหน่วงจริงแค่หน้าต่างวิเคราะห์ ~10 ms (fftSize 512 @48 kHz) กับ 1 เฟรม (~16 ms) ซึ่งน้อยกว่าเป้า 50 ms ที่กำหนดไว้ (คำนวณจากการออกแบบ ยังไม่ได้วัดด้วยเครื่องมือ)
- ⚠️ Chrome: stream ที่รับมาต้องถูกเล่นผ่าน `<audio>` ด้วย ไม่งั้น `MediaStreamSource` ใน WebAudio ได้แต่ค่า 0 (`PeerLink` มี `<audio>` อยู่แล้ว) ส่วน `LevelMonitor` ไม่ต่อออกลำโพงเอง เพื่อไม่ให้เสียงซ้อน

---

## 7. Stage Rendering (หัวใจเรื่องภาพคม)

- **ความละเอียดภายในคงที่ 640×360** แล้วขยายขึ้นด้วย CSS เป็น **จำนวนเต็มเท่า** ใช้ `image-rendering: pixelated` ตัวอย่างเช่น 1920×1080 = 3 เท่าพอดี
  - `stageScale()` ใน `layout.ts`: ใช้จำนวนเต็มเสมอ ยกเว้น (ก) จอเล็กกว่า 640 หรือ (ข) จำนวนเต็มจะทิ้งพื้นที่เกิน 30% (เช่นกรอบ 1200 px ได้ 1.67 แทน 1) จึงยอมใช้ทศนิยมใน **พรีวิวของห้อง** ส่วนหน้า OBS ใช้ `strictInteger` เสมอ
  - เทสต์ E2E ยืนยันที่ 1920×1080: ทุกบล็อก 3×3 พิกเซลของภาพที่ถ่ายต้องสีเดียวกันทั้งบล็อก (พิสูจน์แล้วว่าเทสต์จับภาพเบลอได้: ตอนปิด `pixelated` ได้ 24,617 บล็อกที่ไม่สม่ำเสมอ)
- Pixi: `TextureStyle.defaultOptions.scaleMode = 'nearest'`, `antialias: false`, `resolution: 1`, `roundPixels: true`
- ทุก position และ offset ต้องเป็นจำนวนเต็ม (ใช้ `Math.round` ก่อนกำหนดค่าเสมอ)

**Layout (`layout.ts`, เป็น pure function และต้องมี unit test)**
- 1–5 คนจัดเป็น 1 แถว, 6–10 คนจัดเป็น 2 แถว ช่องกว้าง `floor(640/cols)`
- ขนาด avatar = scale แบบจำนวนเต็มที่ใหญ่สุดที่ยังพอดีช่อง (ทุกคนใช้ scale เดียวกัน, สูงสุด 10)
- **พื้นที่ต่อคนคิด (16+2) พิกเซล sprite ต่อด้าน** เผื่อเส้น outline ตอนพูดที่ยื่นออกไปรอบตัว 1 พิกเซล sprite และป้ายชื่อต้องอยู่ใต้ outline (ไม่งั้นคนที่กำลังพูดจะทับชื่อตัวเอง ซึ่งเคยเกิดจริงในเวอร์ชันแรก)
- เปลี่ยน layout ด้วย tween ตำแหน่ง 200 ms (ปัดเศษทุกเฟรม)

**Avatar**
- ใช้ texture `idle`, `talk` และ `blink` (ถ้ามี) ตอนพูดให้สลับเป็น talk และเด้งขึ้น **1 พิกเซล sprite** (ไม่ใช่ 2 px จอ) แบบ step ทุก 140 ms เพื่อให้การเคลื่อนไหวอยู่บนกริดพิกเซลเดียวกับภาพ (ไม่ใช้ sine เพื่อให้ได้ความรู้สึกแบบ pixel)
- **Outline เมื่อพูด:** สร้าง texture ไว้ล่วงหน้าด้วยการ dilate alpha 1 px บน canvas แล้ว tint สี ไม่ใช้ filter เพราะ filter จะทำภาพเบลอ
- blink แบบสุ่มทุก 3–6 วินาที นาน 120 ms

**Auto-pixelize (`pixelize.ts`)** เป็นจุดขายเสริม: ใช้รูปวาดธรรมดาได้
- ถ้ารูปสูงไม่เกิน 160 px ถือว่าเป็น pixel art อยู่แล้ว ใช้ตามเดิม
- ถ้าใหญ่กว่านั้น ย่อลงเหลือความสูงเป้าหมาย 64/96/128 (ให้ผู้ใช้เลือก) ด้วย `imageSmoothingQuality: 'high'` แล้วตัด alpha ที่ 128 (ได้ 0 หรือ 255 เท่านั้น) จะได้ขอบที่คม
- export เป็น PNG แล้วเก็บไว้ใน IndexedDB ของเครื่องตัวเอง

**Default avatar (`procedural.ts`)** สร้างตัวละคร 16×16 แบบสมมาตรจาก seed (คล้าย identicon) มีทั้งท่าปากปิดและปากเปิด จึงไม่มีปัญหาลิขสิทธิ์และทุกคนได้ตัวละครเฉพาะตัวทันที

**ป้ายชื่อ (`text.ts`)** ⚠️ ความเสี่ยง: pixel font ส่วนใหญ่ไม่มีอักษรไทย
- แผน: วาดข้อความด้วย canvas 2D ขนาด 12–16 px แล้วตัด alpha เหลือ 0/255 จากนั้นใช้เป็น texture แบบ nearest
- ถ้าหา pixel font ภาษาไทยที่ใช้ license แบบ OFL หรือ CC0 ได้ จะเปลี่ยนไปใช้ font นั้น
- **ทำแล้วใน M3:** วาดด้วย Kanit (โหลดจาก Google Fonts, มี fallback) แล้วตัด alpha เป็น 0/255 ดูภาพจริงแล้วอ่านชื่อไทย ("สมชาย") ได้ชัด

**หน้า dev `/dev/stage?n=1..10[&full]`** (มีเฉพาะตอน `vite dev`, ไม่อยู่ใน production) แสดงตัวละครปลอม N ตัวผลัดกันพูด ไม่ต้องใช้ไมค์หรือเครือข่าย ใช้ดูภาพและให้เทสต์วัด FPS/ความคม โดย `?full` = เต็มหน้าจอแบบจำนวนเต็มเท่า

**ฉากหลัง:** ใช้ภาพขนาด 640×360 (PNG หรือ GIF ผ่าน `GifSprite`) มีฉากสำเร็จรูป 3–4 ฉากใน `public/assets/bg` (ต้องตรวจ license ให้เป็น CC0 หรือวาดเอง) และ host อัปเองได้

**Emotes:** ปุ่ม 1–4 คือ กระโดด / หัวใจลอย / เหงื่อ / ❗ ใช้ spritesheet ขนาด 8×8 หรือ 16×16 และระบบ particle ที่เขียนเองบน ticker (pool ไว้ไม่เกิน 64 ตัว) กดซ้ำได้ไม่ถี่กว่า 300 ms

---

## 8. Asset Pipeline (P2P ไม่ผ่าน server)

1. ผู้ใช้เลือกไฟล์ → ถ้าต้องการให้ผ่าน pixelize → ได้ blob PNG → คำนวณ sha256 → เก็บใน IndexedDB
2. พอ data channel ของแต่ละคู่เปิด ให้ส่ง `profile` ที่มีแค่ sha ของรูป
3. ผู้รับเช็ก cache ใน IndexedDB ก่อน ถ้ายังไม่มีไฟล์นั้นจึงส่ง `want` ไป ฝั่งเจ้าของก็ส่ง `file` กลับมาเป็น chunk
4. ผู้รับตรวจ sha256 ให้ตรง, ตรวจ magic bytes (PNG/GIF), ขนาดไม่เกิน 512 KB และขนาดภาพไม่เกิน 1024 px ก่อนนำไปสร้าง texture
5. ฉากที่ host อัปเองใช้วิธีเดียวกัน (ส่งจาก host) ส่วนฉากสำเร็จรูปอ้างด้วย id ไม่ต้องส่งไฟล์
6. sprite หลังผ่าน pixelize มีขนาดราว 5–50 KB ส่งให้ 9 คนก็ใช้เวลาไม่ถึง 1 วินาที

---

## 9. Stage Page สำหรับ OBS

- OBS → Browser Source → URL `/s/:roomId?k=...` ขนาด 1920×1080 และติ๊ก **Control audio via OBS**
- เข้าห้องด้วย `role: 'stage'` แบบ recvonly ไม่มี UI ซ่อน cursor และถ้าใส่ `transparent=1` จะไม่วาดฉาก เพื่อให้ไปใช้ฉากใน OBS แทน
- ปุ่ม "Copy Stage URL" อยู่ในเมนู host
- คู่มือ: ถ้าจะ multistream ให้ใช้ plugin `obs-multi-rtmp` (ฟรี) และต้องปิด audio monitoring ของ source นี้ ไม่อย่างนั้นจะเกิดเสียงสะท้อน

---

## 10. Session Timeline & Export

- Host กด **"เริ่มจับเวลา"** เพื่อตั้ง `t0` (แนะนำให้กดพร้อมกับเริ่มอัดใน OBS) และกดตั้ง t0 ใหม่ได้
- ระบบเก็บ speaking events จาก VAD ของทุกคนไว้ในเครื่อง host (ไม่ส่งไป server)
- **Bookmark:** กดปุ่มหรือคีย์ `B` แล้วพิมพ์ note สั้นๆ ได้
- ขั้นตอนประมวลผล (`timeline.ts`, pure function และต้องมี test): รวมช่วงที่ห่างกันน้อยกว่า 1.5 s และตัดช่วงที่สั้นกว่า 0.5 s ทิ้ง
- Export:
  - `timeline.csv` คอลัมน์ `start,end,duration,speaker,type,note`
  - `markers.json`
  - **YouTube Chapters** คัดลอกได้ทันที โดยบังคับให้บรรทัดแรกเป็น `00:00`, มีอย่างน้อย 3 บท และแต่ละบทยาวอย่างน้อย 10 s ตามกฎของ YouTube
- เก็บข้อมูลไว้ใน IndexedDB ระหว่าง session ทำให้ refresh แล้วไม่หาย

### ข้อมูลทั้งหมดอยู่ที่ไหน (ไม่มี database)

| ข้อมูล | ที่เก็บ |
|---|---|
| ชื่อ, sprite, ความไวไมค์, hostKey ของห้องตัวเอง | localStorage / IndexedDB ในเครื่องผู้ใช้ |
| sprite ของคนอื่น (cache) | IndexedDB ในเครื่องผู้ใช้ (ใช้ sha เป็น key) |
| ใครอยู่ในห้อง, host, สถานะล็อก | หน่วยความจำของ DO ระหว่างที่มีคนเชื่อมต่อ |
| Timeline / bookmark | IndexedDB ในเครื่อง host |
| เสียง | วิ่ง P2P ไม่ถูกเก็บที่ไหนเลย |

---

## 11. Security & Limits

- ID และ key เดาไม่ได้ (ดูข้อ 3) และคำสั่ง host ต้องตรวจ hostKey ฝั่ง DO ทุกครั้ง
- ชื่อยาวไม่เกิน 24 ตัวอักษร และ React escape ให้อยู่แล้ว
- Worker ตั้ง header CSP, `X-Content-Type-Options: nosniff` และ `Referrer-Policy: no-referrer` (ไม่ให้ roomId รั่วไปกับ referrer)
- Rate limit แบบ token bucket ต่อ socket ภายใน DO
- Worker ตรวจรูปแบบ `roomId` (base58 ยาว 16 ตัว) ก่อนส่งต่อให้ DO
- ถ้ามีการ spam เปิด WebSocket จำนวนมาก ให้เพิ่ม Cloudflare Turnstile (ฟรี) ก่อนเชื่อม WS
- Media และ data channel เป็น DTLS แบบ P2P ไม่ผ่าน server จึงตรงกับ NFR-3.1 และ server ไม่เห็นทั้ง sprite และเสียง

**โควตาฟรี** (DO: 100k requests/วัน และนับ WS message แบบ 20:1)
- การเข้าห้อง 1 ครั้งใช้ประมาณ 1 upgrade บวก signaling ราว 2 request ส่วน emote และไฟล์วิ่ง P2P ไม่นับโควตา
- ประเมินว่ารับได้หลายพันห้องต่อวัน

---

## 12. Testing

| ระดับ | สิ่งที่ทดสอบ |
|---|---|
| Unit (vitest) | `layout`, `timeline` merge, YouTube chapters formatter, scale calc, protocol schemas |
| Worker (vitest-pool-workers) | join/leave, FULL/LOCKED/kick, hostKey ↔ roomId check, BAD_ROOM, state รอดหลัง hibernate (attachment) |
| Unit (เพิ่ม) | การแบ่ง/ประกอบ chunk ไฟล์ + ตรวจ sha256, `roomId = f(hostKey)` |
| E2E (Playwright) | Chromium 2–3 context ใส่ `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=tone.wav` แล้วตรวจว่าเชื่อมต่อกันได้และ VAD ตรวจเจอเสียง |
| Manual | 2 เครือข่ายจริง (wifi กับ 4G), Firefox/Edge, ห้อง 6 คน วัด FPS, OBS ไลฟ์ขึ้น YouTube (unlisted) |

---

## 13. Deploy

1. `npx wrangler login`
2. `npm run deploy` (คำสั่งคือ `vite build && wrangler deploy`) จะได้ `https://pixel-live.<account>.workers.dev`
3. Cloudflare Dashboard → Workers → Settings → **Builds → Connect to GitHub** ทำให้ push เข้า `main` แล้ว deploy อัตโนมัติ และแต่ละ branch ได้ preview URL
4. `wrangler.jsonc` ต้องมี `assets.not_found_handling: "single-page-application"` และ DO migration `new_sqlite_classes: ["RoomDO"]` (แพ็กเกจฟรีบังคับให้ DO เป็นประเภท SQLite แม้โค้ดจะไม่เรียก storage เลย)

---

## 14. Milestones (แต่ละงานต้องผ่านเกณฑ์เสร็จก่อนขึ้นงานถัดไป)

| # | งาน | เกณฑ์เสร็จ |
|---|---|---|
| **M0** | Scaffold + deploy hello world + เชื่อม GitHub | URL บน workers.dev ใช้งานได้ และ push แล้ว deploy เอง |
| **M1** | RoomDO relay + สร้างห้องฝั่ง client + หน้า Home/Room แสดงรายชื่อคนในห้อง | เปิด 2 แท็บแล้วเห็นรายชื่อกันแบบ realtime, refresh แล้วกลับเข้าห้องเดิมได้, คนที่ไม่มี hostKey ปลอมเป็น host ไม่ได้, test ของ worker ผ่าน |
| **M2** | Audio mesh + data channel + perfect negotiation + mic picker | 2 เครื่องคนละเครือข่ายได้ยินเสียงกันภายใน 30 วินาที, เปิด 6 แท็บแล้วได้ยินกันครบ, ออกแล้วเข้าใหม่ได้ |
| **M3** | Pixi stage + layout + procedural avatar + VAD | พูดแล้วปากเปิดภายในประมาณ 50 ms, ขยาย 1080p แล้วขอบคม, 6 คนได้ 60 FPS |
| **M4** | อัป avatar + pixelize + ส่งไฟล์ P2P | อัปรูป 1000 px แล้วกลายเป็น pixel art, peer ทุกคนรวมถึง stage เห็นภาพเดียวกัน, คนที่เข้าทีหลังก็ได้รับ sprite ครบ |
| **M5** | ฉากหลัง + host controls (bg / kick / lock) | เปลี่ยนฉากแล้วทุกคนรวมถึง stage เห็นภาพเดียวกัน, guest เรียกคำสั่ง host ไม่ได้ |
| **M6** | Emotes | กดปุ่ม 1–4 แล้วทุกคนเห็น effect ภายใน 200 ms |
| **M7** | Stage page สำหรับ OBS | ไลฟ์ unlisted ขึ้น YouTube ได้ภาพและเสียงครบ ไม่มีเสียงสะท้อน |
| **M8** | Timeline + bookmark + export | วางข้อความ chapters ใน YouTube แล้วระบบรับ, CSV เปิดใน Excel ได้ |
| **M9** | Polish: UI ธีม retro, mic test meter, error states, TURN | เครือข่ายที่ต้องใช้ TURN ก็เชื่อมต่อได้, ทุก error มีข้อความภาษาไทยที่เข้าใจได้ |

**ความเสี่ยงที่ต้องพิสูจน์ก่อน:** M2 (mesh ข้ามเครือข่าย) และ M3 (ภาพคม + lip-sync) ถ้าสองข้อนี้ผ่าน งานที่เหลือเป็นงาน UI และงาน logic ทั่วไป
