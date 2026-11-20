# StreamHub

A video streaming platform with a custom HTML5 player, tiered subscriptions (Razorpay test mode), controlled downloads, multilingual comments with moderation, WebRTC video calling, and login-security features (risk-based OTP, trusted devices, login-time theming).

| Layer | Stack |
| --- | --- |
| Client | React 18, Vite, TypeScript, React Router |
| Server | Node 22, Express, TypeScript, Socket.IO |
| Data | MongoDB 7 (replica set) via Prisma |
| Payments | Razorpay (test mode) |
| Email | Nodemailer (Mailpit in dev) |
| Calls | WebRTC mesh, Socket.IO signaling |

## Getting started

Prerequisites: Node 22+, Docker, ffmpeg (`brew install ffmpeg`).

```bash
npm install
cp server/.env.example server/.env   # then set JWT_SECRET and Razorpay test keys
npm run setup                        # starts MongoDB + Mailpit, pushes the schema, generates sample videos, seeds
npm run dev                          # API on :4000, web app on http://localhost:5173
```

To use MongoDB Atlas instead of the local container, put your Atlas connection string in `DATABASE_URL`
and run `npm run db:push -w server && npm run media:fetch -w server && npm run db:seed -w server`.
MongoDB must be a replica set (Atlas always is), because Prisma needs one for transactions.

Seeded accounts (password `Password@123`):

- `admin@streamhub.local` — admin (comment moderation)
- `demo@streamhub.local` — regular user

Dev tools:

- **Mailpit** (OTP codes, invoices, reminders): http://localhost:8025
- OTP codes are also printed to the server console in development.
- **Razorpay test cards:** `4111 1111 1111 1111`, any future expiry, any CVV; or UPI `success@razorpay` / `failure@razorpay`.

## Project layout

```
server/
  prisma/schema.prisma      all models
  prisma/seed.ts            users + sample catalog
  scripts/fetch-media.ts    generates sample videos/thumbnails/captions with ffmpeg
  src/
    app.ts, index.ts        Express app + HTTP/Socket.IO server
    config.ts               env-driven settings
    lib/                    prisma, plans/entitlements, IST time helpers, client info + geo-IP, mailer
    middleware/auth.ts      cookie JWT sessions (revocable server-side)
    modules/
      auth/                 register, login, risk assessment, OTP
      security/             login history, trusted devices, sessions
      users/                profile, theme, entitlements, @mention search
      videos/               catalog, range streaming, watch progress, limits
      subscriptions/        plans, Razorpay orders/verify/webhook, invoices, expiry jobs
      downloads/            quota-enforced, tokenised downloads + audit trail
      comments/             comments, moderation pipeline, translation, reports
      meetings/             REST + Socket.IO signaling for video calls
    jobs/                   cron: plan expiry, renewal reminders, stale downloads
client/src/
  auth/, components/, pages/   shell, login/OTP, profile, security
  features/<feature>/          player, subscriptions, downloads, comments, meetings
```

## Feature notes

### Login security and theme

- Each sign-in records IP, browser and version, OS, device type and model, timestamp, and city/state/country. Location comes from ip-api.com; in local dev the server's own public IP is used.
- OTP is required when the sign-in comes from a new browser, a new device, a new IP address or a new city/state. Codes go to email, or to SMS when the user has a phone number.
- Codes are 6 digits, HMAC-hashed, last 10 minutes and allow 5 attempts.
- A verified browser can be trusted for `TRUSTED_DEVICE_DAYS` (default 30). A trusted device skips the browser, device and IP checks, but a change of city or state still asks for a code.
- Theme follows the sign-in time: light from 05:00 to 11:59 IST, dark otherwise. A manual choice is stored on the profile and wins on every device until the user switches back to Automatic.
- The account security page (`/security`) shows login history, trusted devices (revocable) and active sessions (revocable).

> SMS delivery is a stub that logs the code to the console. Plug a provider (e.g. Twilio or MSG91) into `modules/auth/service.ts → deliverOtp`.

### Subscriptions

Plans are defined in `server/src/lib/plans.ts`:

| | Free | Bronze | Silver | Gold |
| --- | --- | --- | --- | --- |
| Monthly / Quarterly / Yearly | ₹0 | ₹99 / ₹279 / ₹999 | ₹199 / ₹549 / ₹1,999 | ₹299 / ₹849 / ₹2,999 |
| Downloads per day (month) | 1 (30) | 5 (100) | 15 (300) | 50 (1000) |
| Watch time | 60 min/day | Unlimited | Unlimited | Unlimited |
| Max quality | 480p | 720p | 1080p | 4K |
| Premium videos | – | ✓ | ✓ | ✓ |
| Ad-free | – | – | ✓ | ✓ |
| Priority access and exclusive courses | – | – | – | ✓ |

- Entitlements are checked live on every request, so an expired plan behaves as Free immediately.
- A background job then downgrades expired plans to Free in the database. Watch history and other data are kept.

### Video calling

- Calls are a peer-to-peer WebRTC mesh: audio and video go directly between browsers, encrypted with DTLS-SRTP, so no server can see the media. This works well up to about 8 participants (`MEETING_MAX_PARTICIPANTS`).
- Larger rooms would need an SFU such as LiveKit or mediasoup.
- Set `TURN_URL`, `TURN_USERNAME` and `TURN_CREDENTIAL` for users behind strict NATs.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API + web app with reload |
| `npm run typecheck` | typecheck both workspaces |
| `npm run build` | production build |
| `npm run setup` | Docker services, push schema, generate media, seed |
| `npm run db:push -w server` | sync the Prisma schema (collections and indexes) to MongoDB |
| `npm run db:seed -w server` | (re)seed users and videos |
