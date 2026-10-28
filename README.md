# ReachInbox email scheduler

A full-stack email scheduling demo: React + TypeScript dashboard, Express API, PostgreSQL, BullMQ/Redis, Elasticsearch, Ethereal SMTP, Google sign-in, and Slack incoming-webhook OAuth.

## What is included

| Assignment area | Implementation |
|---|---|
| Schedule and persist emails | `POST /api/emails/schedule` saves one relational row per recipient and a transactional outbox entry. |
| Durable delayed jobs | An outbox publisher submits jobs to BullMQ with a per-email `jobId` and a persisted delay. Redis AOF and Docker volumes preserve queue state. |
| Duplicate protection | A request's `Idempotency-Key` and payload hash are unique per account. BullMQ job IDs are the email UUID. The worker claims a database row before SMTP and skips `sent` or ambiguous `sending` rows. |
| Concurrent delivery | `WORKER_CONCURRENCY` configures BullMQ worker concurrency. Multiple worker processes share Redis-backed queue and sender limits. |
| Minimum send spacing | BullMQ's distributed limiter permits at most one send every `MIN_SEND_INTERVAL_MS` (default: 2,000 ms) across workers. |
| Hourly sender limits | A Redis Lua counter reserves sender/hour slots atomically. `MAX_EMAILS_PER_HOUR_PER_SENDER` caps per-sender settings; reached jobs are delayed to the next UTC hour, not discarded. |
| Slack alert | A per-user Slack OAuth v2 incoming webhook is encrypted at rest. The first limit hit for a sender/hour sends one real Slack message when the user has connected Slack. |
| Email search | Emails are indexed by recipient, subject, status, and schedule in Elasticsearch and searched from the dashboard. |
| Queue dashboard | Bull Board is mounted at `/admin/queues` and requires the signed-in session. |
| Dashboard | Google sign-in, sender setup, CSV/text lead parsing, scheduled/sent lists, search, Slack connection status, and responsive compose controls. |

## Prerequisites

- Node.js 20+ and npm 10+
- Docker with Compose (or separately managed PostgreSQL, Redis, and Elasticsearch)
- A Google OAuth web client
- An Ethereal test account
- Optional for Slack alerts: a Slack app with `incoming-webhook` scope

## Run locally

1. Copy `.env.example` to `.env` and set `JWT_SECRET` to a random value of at least 32 characters and `ENCRYPTION_KEY` to a different random value of exactly 32 characters. Keep `.env` private.
2. Start the local infrastructure:

   ```sh
   docker compose up -d postgres redis elasticsearch
   ```

3. Configure Google OAuth in [Google Cloud Console](https://console.cloud.google.com/apis/credentials):
   - Add `http://localhost:4000/auth/google/callback` as an authorized redirect URI.
   - Put the web client ID and secret in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
4. Create an Ethereal account at [ethereal.email](https://ethereal.email), then set its SMTP username and password in `SMTP_USER` and `SMTP_PASS`. Ethereal captures messages rather than delivering them to real recipients; use its preview URL for demos.
5. Install and start the API, worker, and dashboard:

   ```sh
   npm install
   npm run dev
   ```

   Open `http://localhost:5173`. The API is at `http://localhost:4000`; health checks are at `/health`.

The API and worker both apply the schema during startup. The first startup waits for PostgreSQL, Redis, and Elasticsearch to be available.

Alternatively, to build and run the complete containerized stack (API, worker, dashboard, and infrastructure) after configuring `.env`:

```sh
docker compose up -d --build
```

Open `http://localhost:5173`. The dashboard's Nginx proxy keeps browser API calls and the session cookie on the frontend origin; the OAuth callback URLs still point to `http://localhost:4000`.

### Optional Slack OAuth setup

Create a Slack app and enable OAuth with the `incoming-webhook` bot scope. Add `http://localhost:4000/auth/slack/callback` as the redirect URL, then set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_CALLBACK_URL` in `.env`. Restart the API, sign in, and use **Connect Slack** in the sidebar. Slack prompts the user to select a channel; connecting/disconnecting takes effect without a redeploy.

### Environment reference

See `.env.example` for every supported setting. Of note:

- `WORKER_CONCURRENCY`: in-flight BullMQ processor concurrency (default `10`).
- `MIN_SEND_INTERVAL_MS`: distributed minimum time between individual jobs (default `2000` ms).
- `MAX_EMAILS_PER_HOUR_PER_SENDER`: maximum configurable sender limit (default `200`).
- `EMAIL_MAX_ATTEMPTS`: shown as the delivery retry setting; BullMQ job retry defaults are currently five attempts.
- `FRONTEND_URL`, `API_URL`, Google and Slack callback URLs must agree with the hostnames used in OAuth and the browser.

For production, use HTTPS, production-grade managed services, secure randomly generated secrets, and a frontend/API deployment on the configured origins. The example database/Redis credentials and non-TLS local URLs are only for local development.

## API overview

- `GET /auth/google` — start Google OAuth; `GET /auth/google/callback` — verify Google ID token and create a signed HttpOnly session cookie.
- `GET /auth/me`, `POST /auth/logout` — session profile and sign out.
- `GET /auth/slack/connect`, `GET /auth/slack/callback`, `GET /auth/slack/status`, `DELETE /auth/slack` — Slack connection lifecycle.
- `GET /api/config` — display server-enforced scheduling limits.
- `GET /api/senders`, `POST /api/senders` — list/create sender identities and configure an hourly cap.
- `POST /api/emails/schedule` — schedule up to 5,000 unique email addresses. Supply `Idempotency-Key` to make request retries safe.
- `GET /api/emails?status=scheduled|sent&q=term` — authenticated, paginated email list. `q` searches recipient and subject in Elasticsearch; failed attempts appear in the sent view.
- `GET /admin/queues` — authenticated live Bull Board.
- `GET /health` — API, PostgreSQL, Redis, Elasticsearch dependency status.

## Scheduling and reliability details

The request transaction inserts email rows, an idempotency record, and outbox records together. A small outbox publisher loop enqueues unpublished records in BullMQ; it is a transactional-outbox recovery mechanism, not a cron scheduler. Deterministic BullMQ job IDs make the publisher safe to retry if it crashes between enqueue and marking an outbox record as published. BullMQ's delayed jobs—not the publisher—control send times. Schedule offsets are calculated as `start time + recipient index × delay`.

PostgreSQL stores job lifecycle state. Redis stores BullMQ's persistent delayed queue and atomic hourly counters; Redis persistence is enabled with AOF and named Docker volumes preserve both Redis and PostgreSQL state across container restarts. On API startup, the outbox publisher republishes any unmarked items. On worker restart, BullMQ recovers delayed and stalled jobs.

The per-sender hourly cap is atomically reserved in Redis using a Lua script, shared by every worker instance. If a sender reaches the cap, the blocked job is moved to the next UTC hour; it remains in BullMQ and gets another chance then. Several jobs can line up at the boundary, but subsequent atomic counter checks spread excess work into later windows. The Redis rate counter reserves attempts before SMTP; transient SMTP failures therefore consume a slot until the next UTC hour, a deliberately conservative trade-off.

For 1,000 or more emails with a similar due time, each recipient is an independent delayed job. BullMQ controls concurrency and the global distributed send limiter spaces provider calls. PostgreSQL persists all recipients before enqueueing, and the outbox publisher handles batches in bounded groups. Provider hourly limits defer excess jobs rather than dropping the batch.

### Delivery semantics limitation

SMTP does not provide a general exactly-once send primitive. If the worker process crashes after an SMTP server accepts a message but before PostgreSQL records `sent`, it is impossible to know with certainty whether retrying would duplicate delivery. This implementation persists a `sending` claim before sending and does **not** retry ambiguous `sending` rows, preventing automatic duplicate sends but potentially requiring manual review for a crash at that exact point. Failures returned by SMTP are recorded as `failed` and retried by BullMQ. Idempotency, job IDs, and row claims prevent ordinary request retries and worker redelivery from sending an already-confirmed email twice.

## Build

```sh
npm run build
```

## Assumptions and limitations

- The demo intentionally uses one shared Ethereal SMTP account; sender records choose the visible `From` name/address. Ethereal is a test SMTP service and will not deliver to real recipients.
- Google and Slack credentials, OAuth consent configuration, Ethereal credentials, and deployment hosting must be supplied by the project owner. The OAuth flows are real and fail explicitly until configured.
- The database/queue/search services must be reachable before starting the API and worker. If Elasticsearch becomes unavailable, search requests fail visibly; email scheduling and delivery remain stored in PostgreSQL/BullMQ.
- Slack alerts are sent once per sender per UTC hour to an installed incoming-webhook channel. If Slack is not connected, rate limiting continues normally without notification.
- The provided Figma board was not accessible from the build environment. The dashboard follows the supplied screenshot's clean white email-workspace, compact left navigation, email list, and focused composer rather than reproducing every exact Figma measurement.

## Submission and hosted link

This folder contains the working source project. No public deployment, private GitHub repository, invited collaborators, demo video, or submission-form response is created by the local build: those require your hosting/GitHub accounts, OAuth/SMTP credentials, and your permission to publish. After the local setup works, deploy the API/worker and frontend to your chosen host and use that host's URL as the working project link.
# Assisment-2
