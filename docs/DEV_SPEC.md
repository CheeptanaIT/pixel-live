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
- rate limit ต่อ socket / ต่อ IP / เพดาน socket ต่อห้อง: ดูข้อ 11

**Data channel `ctl` (reliable, ordered) สร้างใน RTCPeerConnection ทุกคู่**
```ts
{ t: 'profile', avatar: { kind:'seed', seed } | { kind:'sprites', idle, talk, blink? } }  // sha256 ของแต่ละรูป  (ทำแล้ว M4)
{ t: 'want', sha }                                        // ขอไฟล์ที่ยังไม่มีใน cache                  (ทำแล้ว M4)
{ t: 'file', sha, seq, total, data }                      // chunk 16 KB เข้ารหัส base64 ใน JSON          (ทำแล้ว M4)
{ t: 'emote', id: 1|2|3|4 }                               // M6
{ t: 'scene', bg: 'builtin:radio' | sha }                 // ส่งจาก host เท่านั้น (M5)
```
- สคีมาอยู่ใน `shared/p2p.ts` (valibot) ทุกข้อความจากอีกฝั่ง **ต้อง validate** ก่อนใช้เสมอ เพราะมาจากเบราว์เซอร์ของคนอื่นโดยตรง
- เลือก base64 ใน JSON แทน ArrayBuffer ที่เขียนไว้เดิม เพราะไฟล์เล็ก (≤ ~50 KB หลัง pixelize) และจัดการง่ายกว่ามาก (ข้อความเดียวกันทุกชนิด ไม่ต้องแยกกรอบไบนารี)
- ช่องเป็นแบบ negotiated id 0 ทั้งสองฝั่งสร้างเหมือนกัน จึงไม่ต้องรอ `ondatachannel` และไม่มี race เรื่องใครเปิดช่อง
- `sendControl` มี backpressure: ถ้า `bufferedAmount` เกิน 512 KB จะรอ `bufferedamountlow`
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
- **ตัวละครแต่ละตัวมีขนาดไม่เท่ากันได้** (ตัวสุ่ม 16×16, รูปที่อัปสูงสุด 96 px) จึงให้ **แต่ละตัวหา scale จำนวนเต็มของตัวเอง** (`fitScale`, สูงสุด 10) แล้วยืนบนฐานล่างของช่อง (`placeSprite`) แทนที่จะใช้ scale เดียวทั้งห้อง `computeLayout` คืนเฉพาะช่อง + พื้นที่วาด (`bx,by,bw,bh`) + ตำแหน่งป้ายชื่อ
- **พื้นที่ต่อคนต้องเผื่อ (กว้าง +2, สูง +3) พิกเซล sprite** เป็นเส้น outline ตอนพูดรอบตัว 1 พิกเซล sprite และที่ให้เด้งขึ้นอีก 1 พิกเซล ป้ายชื่อต้องอยู่ใต้ outline (ไม่งั้นคนที่กำลังพูดจะทับชื่อตัวเอง ซึ่งเคยเกิดจริงในเวอร์ชันแรก)
- **เพดาน sprite ด้านที่ยาวที่สุด 96 px** (`MAX_SPRITE_SIDE`) เพราะช่องแคบสุด (ห้อง 10 คน กว้าง 128) ใส่ได้ที่ scale 1 พอดี ถ้ากว้างกว่านี้ต้องใช้ scale ต่ำกว่า 1 ซึ่งทำให้พิกเซลเบลอ เทสต์ยืนยันทุกขนาดห้อง 1–10 คน
- ตัวละครต่างขนาดที่ยืนในแถวเดียวกัน **เท้าจะไม่อยู่ระดับเดียวกันเป๊ะ** (ฐานอยู่ที่ขอบล่างลบเส้น outline ซึ่งขึ้นกับ scale) ยอมรับไว้ก่อน
- เปลี่ยน layout ด้วย tween ตำแหน่ง 200 ms (ปัดเศษทุกเฟรม)

**Avatar**
- ใช้ texture `idle`, `talk` และ `blink` (ถ้ามี) ตอนพูดให้สลับเป็น talk และเด้งขึ้น **1 พิกเซล sprite** (ไม่ใช่ 2 px จอ) แบบ step ทุก 140 ms เพื่อให้การเคลื่อนไหวอยู่บนกริดพิกเซลเดียวกับภาพ (ไม่ใช้ sine เพื่อให้ได้ความรู้สึกแบบ pixel)
- **Outline เมื่อพูด:** สร้าง texture ไว้ล่วงหน้าด้วยการ dilate alpha 1 px บน canvas แล้ว tint สี ไม่ใช้ filter เพราะ filter จะทำภาพเบลอ
- blink แบบสุ่มทุก 3–6 วินาที นาน 120 ms

**Auto-pixelize (`pixelize.ts`)** เป็นจุดขายเสริม: ใช้รูปวาดธรรมดาได้
- **ด้านที่ยาวที่สุดไม่เกิน 96 px ถือว่าเป็น pixel art อยู่แล้ว ใช้ตามเดิม** ไม่ย่อ ไม่เบลอ (แก้จากแผนเดิมที่ใช้ 160 px ความสูง เพราะต้องไม่เกินเพดานข้างบน)
- ใหญ่กว่านั้น ย่อให้ด้านที่ยาวที่สุดเท่าที่ผู้ใช้เลือก **32/48/64/96** (แผนเดิม 64/96/128 ใช้ไม่ได้เพราะ 128 ล้นช่องห้อง 10 คน) ด้วย `imageSmoothingQuality: 'high'` แล้วตัด alpha ที่ 128 (ได้ 0 หรือ 255 เท่านั้น) จะได้ขอบที่คม (เทสต์ E2E ยืนยันว่าหลัง pixelize มี alpha แค่ {0, 255})
- รูป "ตอนพูด" เป็นทางเลือก ถ้าไม่ใส่จะใช้รูปเงียบ (ยังเด้งและเรืองแสงตอนพูด) รูปทั้งสองถูกบังคับให้ขนาดเท่ากัน ไม่งั้นตัวละครจะกระโดดตอนเริ่มพูด ยังไม่มี UI สำหรับรูป blink (โครงรองรับแล้ว)
- GIF ใช้เฟรมแรก ไฟล์ต้นฉบับไม่เกิน 5 MB
- export เป็น PNG แล้วเก็บไว้ใน IndexedDB ของเครื่องตัวเอง (key = sha256)

**Default avatar (`procedural.ts`)** สร้างตัวละคร 16×16 แบบสมมาตรจาก seed (คล้าย identicon) มีทั้งท่าปากปิดและปากเปิด จึงไม่มีปัญหาลิขสิทธิ์และทุกคนได้ตัวละครเฉพาะตัวทันที
- seed เป็นค่าสุ่มที่จำไว้ใน localStorage (ไม่ใช่ `peerId` เหมือนตอน M3) กด 🎲 เพื่อสุ่มใหม่ และ **ส่งให้คนอื่นเป็นข้อความ `profile` สั้นๆ ไม่ต้องส่งไฟล์รูป** คนอื่นสร้างตัวเดียวกันได้เองเพราะ generator เป็น deterministic

**ป้ายชื่อ (`text.ts`)** ⚠️ ความเสี่ยง: pixel font ส่วนใหญ่ไม่มีอักษรไทย
- แผน: วาดข้อความด้วย canvas 2D ขนาด 12–16 px แล้วตัด alpha เหลือ 0/255 จากนั้นใช้เป็น texture แบบ nearest
- ถ้าหา pixel font ภาษาไทยที่ใช้ license แบบ OFL หรือ CC0 ได้ จะเปลี่ยนไปใช้ font นั้น
- **ทำแล้วใน M3:** วาดด้วย Kanit (โหลดจาก Google Fonts, มี fallback) แล้วตัด alpha เป็น 0/255 ดูภาพจริงแล้วอ่านชื่อไทย ("สมชาย") ได้ชัด

**หน้า dev `/dev/stage?n=1..10[&full]`** (มีเฉพาะตอน `vite dev`, ไม่อยู่ใน production) แสดงตัวละครปลอม N ตัวผลัดกันพูด ไม่ต้องใช้ไมค์หรือเครือข่าย ใช้ดูภาพและให้เทสต์วัด FPS/ความคม โดย `?full` = เต็มหน้าจอแบบจำนวนเต็มเท่า

**ฉากหลัง:** ใช้ภาพขนาด 640×360 (PNG หรือ GIF ผ่าน `GifSprite`) มีฉากสำเร็จรูป 3–4 ฉากใน `public/assets/bg` (ต้องตรวจ license ให้เป็น CC0 หรือวาดเอง) และ host อัปเองได้

**Emotes:** ปุ่ม 1–4 คือ กระโดด / หัวใจลอย / เหงื่อ / ❗ ใช้ spritesheet ขนาด 8×8 หรือ 16×16 และระบบ particle ที่เขียนเองบน ticker (pool ไว้ไม่เกิน 64 ตัว) กดซ้ำได้ไม่ถี่กว่า 300 ms

---

## 8. Asset Pipeline (P2P ไม่ผ่าน server)

1. ผู้ใช้เลือกไฟล์ → pixelize → PNG → คำนวณ sha256 → เก็บใน IndexedDB (`blobs.ts`, key = sha, สำรองในหน่วยความจำถ้า IDB ใช้ไม่ได้, ตัดของเก่าเมื่อเกิน 300 รายการ)
2. พอ data channel ของแต่ละคู่เปิด ส่ง `profile` ที่มีแค่ sha ของรูป (หรือ seed) ถ้าเปลี่ยนตัวละครกลางห้องก็ส่งใหม่ให้ทุกคู่ที่เปิดอยู่
3. ผู้รับเช็ก cache ใน IndexedDB ก่อน ถ้ายังไม่มีไฟล์นั้นจึงส่ง `want` ไป ฝั่งเจ้าของก็ส่ง `file` กลับมาเป็น chunk (`transfer.ts`, `AvatarSync`)
4. **กฎความปลอดภัยของผู้รับ** (ทุกข้อมีเทสต์ และเทสต์พิสูจน์แล้วว่าล้มเมื่อเอากฎออก):
   - รับ `file` เฉพาะ sha ที่ตัวเองขอจาก peer นั้น (`wanted`) ไฟล์ที่ไม่ได้ขอถูกทิ้ง
   - ตรวจ sha256 ของไฟล์ที่ประกอบเสร็จให้ตรงกับที่ขอ ไม่ตรงทิ้ง **ไม่ลองซ้ำ**
   - จำกัดขนาด 256 KB รวม, chunk ละไม่เกิน 16 KB, จำนวน chunk ไม่เกิน 16, base64 ผิดรูปแบบทิ้งทั้งไฟล์
   - ตรวจว่าเป็น PNG และอ่านขนาดจาก IHDR header **ก่อน decode** (กัน decompression bomb) ต้อง ≤ 96 px
   - profile ใหม่ยกเลิกการดาวน์โหลดเก่า ข้อความจาก peer ที่ไม่รู้จักหรือ schema ผิดถูกทิ้งเงียบๆ
5. **กฎความปลอดภัยของผู้ส่ง:** ตอบ `want` เฉพาะไฟล์ในอวตารของตัวเองเท่านั้น (ไม่ใช่ทุกอย่างใน cache) และไฟล์เดิมให้ peer เดิมไม่เกินครั้งละ 5 วินาที กัน peer ที่ส่ง `want` รัวๆ ให้เราอัปโหลดซ้ำ
6. ฉากที่ host อัปเองจะใช้วิธีเดียวกัน (M5) ส่วนฉากสำเร็จรูปอ้างด้วย id ไม่ต้องส่งไฟล์
7. sprite หลังผ่าน pixelize มีขนาดราว 5–50 KB ส่งให้ 9 คนก็ใช้เวลาไม่ถึง 1 วินาที
8. **ยังไม่มี:** timeout/ลองใหม่ถ้าไฟล์ค้างกลางทาง (ถ้า channel ปิดแล้วเปิดใหม่ จะส่ง profile ใหม่เอง) และคนที่เข้าห้องทีหลังจะได้ไฟล์จากเจ้าของเท่านั้น ไม่ได้จากคนอื่นที่มี cache

---

## 9. Stage Page สำหรับ OBS

**ทำแล้วใน M7** (หน้า `src/routes/Stage.tsx`, 10 เทสต์ E2E ใน `e2e/obs.spec.ts`)

- OBS → Browser Source → URL `/s/:roomId` (ไม่มี `?k=` ตามที่เขียนไว้เดิม เพราะ roomId เป็นความลับอยู่แล้ว ดูหมายเหตุด้านล่าง) ขนาด 1920×1080 และติ๊ก **Control audio via OBS**
- เข้าห้องด้วย `role: 'stage'` **ฟังอย่างเดียว** ไม่ส่งเสียง ไม่มีตัวละครของตัวเอง ไม่อยู่ในรายชื่อของใคร (นับเป็น 1 ใน 2 ที่นั่ง stage) และ **ไม่เขียนทับชื่อที่เบราว์เซอร์จำไว้** (เคยเป็นความเสี่ยงตอนทดสอบลิงก์ OBS ในเบราว์เซอร์ตัวเอง มีเทสต์กัน)
- ไม่มี UI ใดๆ, ซ่อน cursor, เต็มหน้าต่าง, **ขยายเป็นจำนวนเต็มเท่าเสมอ** (`strictInteger`) แล้วจัดกึ่งกลาง: 1080p = 3 เท่า, 720p = 2 เท่า, หน้าต่างที่ได้ 1.5 เท่า = 1 เท่า (ไม่ใช้ทศนิยมให้ภาพเบลอ)
- `?transparent=1`: ไม่วาดฉาก พื้นหลัง alpha 0 ทั้งหน้า (ขอบตัวละครและชื่อเป็น 0/255 ไม่มีขอบกึ่งโปร่งใส) เทสต์ตรวจจากภาพจริง
- **อย่าแสดงข้อความสถานะบนภาพ** เพราะภาพนี้คือสิ่งที่ถูกไลฟ์ออกไป: หน้าจอ "กำลังเชื่อมต่อใหม่" จะไม่แสดง (เชื่อมต่อใหม่เงียบๆ) แสดงเฉพาะตอนเข้าห้องไม่ได้ เช่น ห้องล็อก/เต็ม ซึ่ง **ลองใหม่เองทุก 5 วินาที** ไม่ต้อง refresh ใน OBS
- **นโยบาย autoplay:** OBS อนุญาตเล่นเสียงอัตโนมัติ แต่เบราว์เซอร์ปกติไม่ ในแท็บธรรมดาเสียง (และการขยับปากที่วัดจากเสียง) จะเงียบจนกว่าจะคลิก หน้าจึงแสดงป้ายเล็กๆ "คลิกที่หน้านี้หนึ่งครั้งเพื่อเปิดเสียง" เฉพาะตอนถูกบล็อก (ตรวจจาก `play()` ถูกปฏิเสธ หรือ AudioContext ค้าง `suspended`) และหายเมื่อคลิก ใน OBS ป้ายนี้ไม่ควรโผล่
- แผง "📺 ไลฟ์ผ่าน OBS" ในห้อง **เฉพาะ Host**: ลิงก์พร้อมคัดลอก, ตัวเลือกพื้นหลังโปร่งใส, ขั้นตอน 5 ข้อ, และป้าย "● OBS เชื่อมต่ออยู่" ให้ยืนยันได้ว่าเชื่อมแล้ว
- คู่มือในแผง: ติ๊ก **Control audio via OBS**; **ปิด** "Shutdown source when not visible" และ "Refresh browser when scene becomes active" (ไม่งั้นหลุดทุกครั้งที่สลับฉาก); ปิด Audio Monitoring ของ source นี้ (ไม่งั้นเสียงสะท้อน); multistream ใช้ปลั๊กอินฟรี `obs-multi-rtmp`

**ข้อควรรู้**
- ลิงก์ OBS (`/s/:roomId`) **ความลับเท่าลิงก์เชิญ** ใครได้ไปก็ฟังห้องได้ (แผงเตือนไว้แล้ว) ไม่มี stageKey แยก ถ้าจะแยกสิทธิ์ต้องมีกลไกเพิ่ม
- **ยังไม่ได้ทดสอบกับ OBS ตัวจริง** (ทดสอบกับ Chromium ที่ใช้ไมค์ปลอม) OBS ใช้ Chromium Embedded Framework ที่เวอร์ชันอาจเก่ากว่า จึงควรลองกับ OBS จริงสักครั้ง โดยเฉพาะ WebGL, ความโปร่งใส และเสียง
- ในเทสต์ Playwright การ polling บนหน้าใดๆ **นับเป็น user gesture** (ปลดบล็อก autoplay เอง) เทสต์ป้ายจึงต้องรอโดยไม่แตะหน้าแล้วตรวจครั้งเดียว

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
- **HTTP headers (`public/_headers`, ทำแล้ว):** `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (ไม่ให้ roomId ใน URL รั่วไปกับ referrer), `X-Frame-Options: DENY`, `Permissions-Policy` (ไมค์ใช้ได้เฉพาะหน้าเราเอง) ทดสอบแล้วว่าเสิร์ฟครบทุกหน้า และเทสต์ E2E ผ่านกับบิลด์ production ที่ใช้ header นี้
- **CSP ยังไม่ได้ทำ** (เอกสารฉบับก่อนเขียนว่าทำแล้ว แต่ไม่จริง): Pixi v8 ใช้การสร้างโค้ดแบบ `eval` ในบางเส้นทาง CSP ที่เข้มจะทำให้เวทีพังแบบเงียบๆ ต้องทดสอบจริงก่อน และต้องเปิดทางให้ Google Fonts, `blob:`, `ws:`/`wss:` ไว้ด้วย
- Worker ตรวจรูปแบบ `roomId` (base58 ยาว 16 ตัว) ก่อนส่งต่อให้ DO

### การจำกัดอัตรา (ทำแล้ว, มีเทสต์และเทสต์พิสูจน์แล้วว่าล้มเมื่อปิดกลไก)

| ชั้น | กลไก | ค่า |
|---|---|---|
| Worker | `ratelimits` binding ต่อ IP (`CF-Connecting-IP`) เฉพาะคำขอ upgrade ที่ถูกต้อง ตอบ 429 + `Retry-After` | 60 ครั้ง/นาที/IP (ข้ามถ้าไม่มี header คือตอน dev) |
| RoomDO | token bucket ต่อ socket ตรวจก่อน parse (`shared/ratelimit.ts`) | burst 600, เติม 20/วินาที, ตัดทิ้งหลังถูกทิ้ง 100 ข้อความติด → ปิดด้วย `1013` (ไม่ใช่โค้ดถาวร ลูกค้าปกติต่อใหม่ได้) |
| RoomDO | ข้อความใหญ่เกิน 16 KB → ปิด `1009` | SDP จริงมีแค่ไม่กี่ KB |
| RoomDO | socket ที่ไม่ส่ง hello ภายใน 10 วินาทีถูกปิด `1008` (ล้างตอนมีคนต่อเข้ามาใหม่ ไม่ใช้ timer/storage) | `HELLO_TIMEOUT_MS` |
| RoomDO | เพดาน 24 socket ต่อห้อง เกินแล้วตอบ `FULL` | |

- ค่า burst มาจากการ**วัดจริง**: คนเข้าห้องส่งราว 5 ข้อความต่อ peer (ห้อง 10 คน ≈ 60 ข้อความ) ตั้ง 600 = 10 เท่า เผื่อเครือข่ายจริงที่มี ICE candidate มากกว่า (srflx/IPv6/relay)
- **บั๊กที่เจอจากเทสต์ชุดนี้:** ทุกกรณีที่ server เป็นฝ่ายปิดเอง (ตัดเพราะยิงถี่, ข้อความใหญ่) runtime ไม่เรียก `webSocketClose` ให้ทัน จึงไม่มีการประกาศ `leave` และคนอื่นในห้องเห็น "ผี" ค้างอยู่ แก้โดยให้ทุกเส้นทางผ่าน `hangUp()` ที่เรียก `removePeer` เอง (เส้นทางเตะทำถูกอยู่แล้วตั้งแต่ M1)

**ข้อจำกัดที่ต้องรู้ (ไม่ใช่การป้องกันบอตจริงจัง):**
- `ratelimits` binding เป็นแบบ eventually consistent ตามที่ Cloudflare ระบุ ใช้เป็นแนวกันความผิดพลาดและการยิงแบบธรรมดา ไม่ใช่ระบบนับที่แม่นยำ
- **คำขอที่ถูกตอบ 429 ก็ยังกินโควตา 100,000 request/วันของ Worker อยู่ดี** เพราะ Worker ถูกเรียกไปแล้ว การป้องกันบอตจริงต้องใช้ WAF/Rate Limiting rules ของ Cloudflare บนโดเมนของตัวเอง ซึ่งใช้บน `workers.dev` ไม่ได้
- ตรวจบน production จริงแล้ว: ยิงเชื่อมต่อต่อเนื่องจาก IP เดียว รับ 53 ครั้งแล้วเริ่มปฏิเสธที่ครั้งที่ 54 (ก่อนหน้านั้นมีการเชื่อมต่อของชุดทดสอบอีกราว 35 ครั้งในช่วงนาทีเดียวกัน ตัวเลขจึงสอดคล้องกับเพดาน 60) ยังปฏิเสธต่อเนื่อง และกลับมาเชื่อมได้หลังรอ 65 วินาที ชุดทดสอบ E2E ทั้งชุด (ราว 35 การเชื่อมต่อ/นาที) ไม่ชนเพดาน
- ห้องที่ถูกยิงด้วย socket ที่ไม่ส่ง hello ครบ 24 ตัวจะตอบ `FULL` กับคนจริงจนกว่าจะถูกล้าง (ภายใน ~10 วินาทีหลังมีการเชื่อมต่อครั้งถัดไป) แต่ผู้โจมตีจาก IP เดียวทำต่อเนื่องไม่ได้เพราะ 24 socket ต่อ 10 วินาที เกินเพดาน 60/นาที
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
