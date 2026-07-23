# Telegram Ads Bot → Google Sheets / Google Drive

Bot สำหรับเก็บข้อมูลโฆษณาจากกลุ่ม Telegram บันทึกลง Google Sheets และเก็บรูปภาพใน Google Drive อัตโนมัติ

## คุณสมบัติหลัก

- รับข้อมูลโฆษณาได้เฉพาะจากกลุ่ม (group/supergroup) ที่กำหนดเท่านั้น ห้ามบันทึกผ่านแชทส่วนตัว
- Parse ข้อความแบบ `key : value` อัตโนมัติ พร้อมถามข้อมูลที่ขาดผ่านแชท
- รองรับ Platform หลายตัว (Facebook, TikTok, Telegram, Google Ads, LINE ฯลฯ) แบบ free text
- สร้างโครงสร้าง Folder ใน Google Drive อัตโนมัติ: `Website / Year / Month / Photos`
- บันทึกข้อมูลลง Google Sheets พร้อม header จัดรูปแบบสวยงาม
- ระบบสิทธิ์ 3 ระดับ: Super Admin / Authorized User / Unauthorized
- Log การทำงานทุกวันแยกไฟล์ พร้อม log action ละเอียด
- จำ default website/platform ต่อ session ไม่ต้องพิมพ์ซ้ำ

## โครงสร้างโปรเจกต์

```
telegram-ads-bot/
├── src/
│   ├── index.ts              # Entry point
│   ├── bot/                  # handlers, commands, parser
│   ├── google/               # Google Sheets / Drive integration
│   ├── services/             # dataProcessor, memory, logger
│   ├── types/                 # TypeScript types
│   └── config/                # config & authorization store
├── logs/                      # Log รายวัน
├── data/                       # authorized-users.json, allowed-groups.json, sessions.json
├── ecosystem.config.js         # PM2 config
└── .env
```

## 1. ติดตั้ง Dependencies

```bash
cd telegram-ads-bot
npm install
```

## 2. สร้าง Telegram Bot Token

1. เปิดแชทกับ [@BotFather](https://t.me/BotFather) ใน Telegram
2. พิมพ์ `/newbot` แล้วทำตามขั้นตอน (ตั้งชื่อ bot และ username)
3. BotFather จะให้ **Token** มา เช่น `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
4. เก็บ Token นี้ไว้ใส่ในไฟล์ `.env` (`TELEGRAM_BOT_TOKEN`)
5. เพิ่ม bot เข้ากลุ่มที่ต้องการเก็บข้อมูล และตั้งเป็น **Admin** ของกลุ่ม (เพื่อให้อ่านข้อความในกลุ่มได้ครบ)
6. ปิด Privacy Mode ของ bot ผ่าน BotFather: `/mybots` → เลือก bot → `Bot Settings` → `Group Privacy` → `Turn off` (เพื่อให้ bot อ่านข้อความทุกข้อความในกลุ่ม ไม่ใช่แค่ที่ mention)

## 3. สร้าง Google Service Account + เปิด API

1. ไปที่ [Google Cloud Console](https://console.cloud.google.com/)
2. สร้างโปรเจกต์ใหม่ (หรือใช้โปรเจกต์เดิม)
3. เปิดใช้งาน API สองตัว: **Google Sheets API** และ **Google Drive API** (เมนู APIs & Services → Library → ค้นหาแล้วกด Enable)
4. ไปที่ **APIs & Services → Credentials** → `Create Credentials` → `Service Account`
5. ตั้งชื่อ Service Account แล้วกด Create/Done
6. เปิด Service Account ที่สร้าง → แท็บ `Keys` → `Add Key` → `Create new key` → เลือก `JSON` → ดาวน์โหลดไฟล์
7. เปิดไฟล์ JSON ที่ดาวน์โหลดมา คัดลอกค่า:
   - `client_email` → ใส่ใน `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → ใส่ใน `GOOGLE_PRIVATE_KEY` (ต้องใส่ทั้งหมดรวม `\n` หรือใส่ในเครื่องหมาย quote และคง newline ไว้)
8. สร้าง Folder ใน Google Drive ที่จะใช้เป็น Root Folder แล้ว **แชร์ (Share) ให้ Service Account email เป็น Editor**
9. คัดลอก Folder ID จาก URL (ส่วนหลัง `/folders/`) → ใส่ใน `GOOGLE_DRIVE_ROOT_FOLDER_ID`

> **สำคัญ:** ทุก Google Sheets ที่ bot สร้างจะอยู่ภายใต้ Root Folder นี้ ต้อง share Service Account เป็น Editor ไม่เช่นนั้น bot จะสร้าง/แก้ไขไฟล์ไม่ได้

## 4. ตั้งค่า .env

```bash
cp .env.example .env
```

แก้ไขค่าต่าง ๆ ในไฟล์ `.env`:

```
TELEGRAM_BOT_TOKEN=123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIExxxx...\n-----END PRIVATE KEY-----\n"
GOOGLE_DRIVE_ROOT_FOLDER_ID=1AbCdEfGhIjKlMnOpQrStUvWxYz
SUPER_ADMIN_ID=509832984
AUTHORIZED_USERS=509832984,111111111
ALLOWED_GROUP_IDS=-1001234567890,-1009876543210
LOG_LEVEL=info
```

วิธีหา **Group ID**: เพิ่ม bot เข้ากลุ่ม ส่งข้อความในกลุ่ม แล้วดู log ของ bot (หรือใช้ bot อย่าง [@RawDataBot](https://t.me/RawDataBot) เพื่อดู chat id ของกลุ่ม — ปกติจะขึ้นต้นด้วย `-100`)

## 5. รันโหมดพัฒนา (Development)

```bash
npm run dev
```

## 6. Build และรัน Production

```bash
npm run build
npm start
```

## 7. Deploy บน VPS ด้วย PM2

```bash
npm install -g pm2
npm run build
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # ตั้งค่าให้ PM2 เริ่มอัตโนมัติเมื่อ VPS reboot
```

คำสั่ง PM2 ที่ใช้บ่อย:

```bash
pm2 logs telegram-ads-bot     # ดู log แบบ real-time
pm2 restart telegram-ads-bot  # restart bot
pm2 stop telegram-ads-bot     # หยุด bot
pm2 status                     # ดูสถานะ
```

## 8. ตัวอย่างการใช้งาน

ส่งข้อความในกลุ่มที่อนุญาต:

```
date : 21/7/2026
Total Message : 174
CPR : 10.23 bath
Total Spent : 1780.63 bath
Impressions : 13543
Reach : 8875
Target audience : 20,50 / gambling
ads name : Thailand free spin
location : Thailand
website : SH666
platform : Facebook
```

Bot จะ parse ข้อมูล แสดงสรุปให้ตรวจสอบ พร้อมปุ่ม ✅ ยืนยัน / ✏️ แก้ไข / ❌ ยกเลิก
ถ้าข้อมูลบาง field ขาด (เช่นไม่ได้ระบุ website หรือ platform) bot จะถามกลับทันที

ตั้งค่า default เพื่อไม่ต้องพิมพ์ website/platform ซ้ำทุกครั้ง:

```
/setwebsite SH666
/setplatform Facebook
```

คำสั่งอื่น ๆ: ดูทั้งหมดด้วย `/help`

## Troubleshooting

| ปัญหา | สาเหตุที่เป็นไปได้ | วิธีแก้ |
|---|---|---|
| Bot ไม่ตอบในกลุ่ม | Privacy Mode เปิดอยู่ หรือกลุ่มไม่ได้อยู่ใน `ALLOWED_GROUP_IDS` | ปิด Privacy Mode ผ่าน BotFather และตรวจสอบ Group ID |
| `403` จาก Google API | ยังไม่ได้ share Root Folder ให้ Service Account เป็น Editor | แชร์ folder ใน Google Drive ให้ email ของ Service Account |
| `PERMISSION_DENIED` ตอนสร้าง Sheet | ยังไม่ได้เปิด Google Sheets API / Google Drive API ใน Cloud Console | เปิด API ทั้งสองใน APIs & Services → Library |
| Private Key error | รูปแบบ `GOOGLE_PRIVATE_KEY` ผิด (ขาด `\n`) | ตรวจสอบว่าใส่ private key ครบพร้อม `\n` หรือ newline จริง |
| ข้อมูลไม่ถูก parse | รูปแบบข้อความไม่ตรง `key : value` | ตรวจสอบว่าใช้เครื่องหมาย `:` คั่นระหว่าง field และค่า |
| ตัวเลขไม่ถูกต้อง | มีตัวอักษรปนในค่าตัวเลข | Bot จะพยายามตัดคำว่า "bath/บาท" และ comma ออกให้อัตโนมัติ |

## หมายเหตุด้านความปลอดภัย

- ไฟล์ `.env` และ `data/*.json` (authorized users, allowed groups, sessions) ไม่ควร commit เข้า git
- Authorized users / allowed groups จัดการผ่านคำสั่ง `/adduser`, `/removeuser`, `/addgroup`, `/removegroup` (Super Admin เท่านั้น) และถูก persist ไว้ใน `data/*.json`
- ทุกการบันทึก/แก้ไข/ลบข้อมูล จะถูก log ไว้ที่ `logs/bot_YYYY-MM-DD.log`
