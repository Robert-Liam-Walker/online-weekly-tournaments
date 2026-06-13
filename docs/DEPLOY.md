# FoxTrot Deploy Runbook (AWS)

Target architecture (locked):

```
                    Route53 (yourdomain.gg)
                   /                       \
        yourdomain.gg                  api.yourdomain.gg
              |                              |
         CloudFront  ──────────────►  Elastic Beanstalk
        /          \    (/api/*,       (single Docker container:
   S3 web bucket    \   /socket.io/*)   Fastify + Socket.io, port 3001)
   (Vite build)      \                   |        |         |
                      \              RDS Postgres │    S3 replays bucket
                       \                    ElastiCache Redis
                        \
                         SES (email — follow-up feature)
```

- **API**: Elastic Beanstalk, *Docker running on 64bit Amazon Linux 2023*,
  single container built from the repo-root `Dockerfile`.
- **DB**: RDS PostgreSQL. **Cache/presence**: ElastiCache Redis.
- **Replays**: S3 (the api switches to S3 automatically when `S3_BUCKET` is
  set — see `apps/api/src/lib/replayStorage.ts`).
- **Web**: Vite static build in S3 behind CloudFront.
- **CI/CD**: `.github/workflows/ci.yml`, `deploy-api.yml`, `deploy-web.yml`.
  Both deploy workflows **skip cleanly until AWS secrets are configured**.

Throughout, replace `yourdomain.gg` and `us-east-1` with your own values.

---

## 0. Prerequisites

- AWS account with admin access (or at least: EB, EC2, RDS, ElastiCache, S3,
  CloudFront, ECR, ACM, Route53, IAM, SES).
- A registered domain (Route53-registered or with NS delegated to Route53).
- AWS CLI v2 configured locally (`aws configure`).
- Docker locally if you want to build/test the image yourself:

  ```sh
  docker build -t foxtrot-api:dev .
  docker run -p 3001:3001 --env-file apps/api/.env foxtrot-api:dev
  ```

### Known issue first: `apps/api/.env` is committed (REMEDIATE BEFORE go-live)

A real `apps/api/.env` (JWT secret, Stripe keys, AWS keys) is tracked in git
history. **Documented steps — run these deliberately, they are not automated
anywhere:**

1. Stop tracking the file (keeps your local copy):

   ```sh
   git rm --cached apps/api/.env
   git commit -m "Stop tracking apps/api/.env"
   ```

2. Confirm `.gitignore` covers it. The root `.gitignore` already has `.env`,
   which matches at any depth; verify with `git check-ignore -v apps/api/.env`
   after step 1. If it doesn't match, add `apps/api/.env` explicitly.

3. **Rotate every secret that file ever contained** — removal does not purge
   git history:
   - `JWT_SECRET` → generate a new 64+ char random string (this invalidates
     all existing sessions/tokens — fine pre-launch).
   - `STRIPE_SECRET_KEY` → roll the key in the Stripe dashboard
     (Developers → API keys → Roll key).
   - `STRIPE_WEBHOOK_SECRET` → recreate the webhook endpoint or roll its
     signing secret in Stripe.
   - `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` → deactivate + delete the
     access key in IAM; create a fresh one only if still needed locally.
   - Treat `DATABASE_URL` / `REDIS_URL` passwords as compromised if they were
     ever non-local values.

4. Optional, if the repo was ever pushed anywhere shared: purge history with
   `git filter-repo --path apps/api/.env --invert-paths` (coordinate with the
   team — it rewrites history).

The Docker build is already protected: `.dockerignore` excludes `**/.env`, so
the file can never end up in an image layer.

---

## 1. Networking baseline

The default VPC is fine to start. Create three security groups (all in the
same VPC):

| SG | Inbound |
|---|---|
| `foxtrot-api-sg` (EB instances) | HTTP 80 from the world (single instance) — EB manages this |
| `foxtrot-db-sg` (RDS) | Postgres 5432 **from `foxtrot-api-sg` only** |
| `foxtrot-redis-sg` (ElastiCache) | Redis 6379 **from `foxtrot-api-sg` only** |

EB creates its own instance SG; you can either reuse it as `foxtrot-api-sg`
or attach an extra one. The important part: DB and Redis are never publicly
reachable.

## 2. RDS PostgreSQL

1. RDS → Create database → PostgreSQL 16, **Single-AZ db.t4g.micro** to
   start (Multi-AZ later).
2. DB name `foxtrot`, master user `foxtrot`, strong generated password.
3. Same VPC as EB; **Public access: No**; SG `foxtrot-db-sg`.
4. Note the endpoint, e.g. `foxtrot.xxxxx.us-east-1.rds.amazonaws.com`.

The connection string the api/Prisma uses:

```
DATABASE_URL=postgresql://foxtrot:<password>@foxtrot.xxxxx.us-east-1.rds.amazonaws.com:5432/foxtrot?schema=public&connection_limit=10
```

This is set as an EB environment property (step 5) — never committed.

**Migrations:** the container entrypoint (`docker-entrypoint.sh`) runs
`npx prisma migrate deploy` at boot **only when `prisma/migrations/` exists
and is non-empty**; until the migrations baseline lands it logs a skip and
starts the api. Two follow-ups when the baseline lands:

- Remove `prisma/migrations/` from the root `.gitignore` (it is currently
  ignored, which would silently keep migrations out of the image — deploy
  would never migrate).
- First deploy against a database that was previously `prisma db push`-ed
  needs `prisma migrate resolve --applied <baseline>` once (standard Prisma
  baselining).

## 3. ElastiCache Redis

1. ElastiCache → Redis OSS → **single `cache.t4g.micro` node**, no cluster
   mode, no replicas (upgrade later).
2. Same VPC; SG `foxtrot-redis-sg`. In-transit encryption off for the
   simple start (`redis://`); if you enable it use `rediss://` and verify
   ioredis TLS config.
3. Note the primary endpoint:

```
REDIS_URL=redis://foxtrot-redis.xxxxx.cache.amazonaws.com:6379
```

## 4. S3 buckets

### 4a. Replays bucket (private)

```sh
aws s3api create-bucket --bucket foxtrot-replays-prod --region us-east-1
aws s3api put-public-access-block --bucket foxtrot-replays-prod \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

The api reads/writes it via the **EB instance role** (no keys in env):
attach this inline policy to the EB instance profile
(`aws-elasticbeanstalk-ec2-role` or a dedicated copy):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject"],
    "Resource": "arn:aws:s3:::foxtrot-replays-prod/replays/*"
  }]
}
```

Then set EB env props `S3_BUCKET=foxtrot-replays-prod` and
`S3_REGION=us-east-1`. Leave `S3_ENDPOINT` **unset** on AWS (it exists for
minio/localstack-style local testing). Local-disk storage remains the
fallback whenever `S3_BUCKET` is unset.

### 4b. Web bucket (private, CloudFront-only)

```sh
aws s3api create-bucket --bucket foxtrot-web-prod --region us-east-1
aws s3api put-public-access-block --bucket foxtrot-web-prod \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Access is granted to CloudFront via Origin Access Control in step 7 — do
not enable website hosting or public reads.

## 5. Elastic Beanstalk (api)

1. **ECR repo** (the deploy workflow pushes here):

   ```sh
   aws ecr create-repository --repository-name foxtrot-api
   ```

2. EB → Create application `foxtrot` → environment `foxtrot-api-prod`:
   - Platform: **Docker running on 64bit Amazon Linux 2023**.
   - Start with **Single instance** (free-tier-ish, no ALB). Move to
     *High availability* (ALB + ASG) when needed — see the Socket.io note
     below before scaling beyond 1 instance.
   - Instance type `t3.small` (the build is done in CI; the instance only
     pulls and runs the image).
3. **Instance profile permissions**: add `AmazonEC2ContainerRegistryReadOnly`
   (pull from ECR) + the replays-bucket policy from step 4a.
4. **Environment properties** (Configuration → Updates, monitoring, and
   logging → Environment properties). This is the secrets channel — EB env
   props are encrypted at rest and never in git:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | from step 2 |
   | `REDIS_URL` | from step 3 |
   | `JWT_SECRET` | fresh 64+ char random string (rotated per §0) |
   | `WEB_URL` | `https://yourdomain.gg` (CORS + Stripe redirects) |
   | `PORT` | `3001` (matches the Dockerrun/EXPOSE) |
   | `NODE_ENV` | `production` |
   | `PAID_EVENTS_ENABLED` | `true` to schedule paid events, else unset |
   | `STRIPE_SECRET_KEY` | rotated live key |
   | `STRIPE_WEBHOOK_SECRET` | from the Stripe webhook endpoint pointing at `https://api.yourdomain.gg/api/webhooks/stripe` |
   | `STRIPE_PRICE_ID` | live $5/mo price id |
   | `S3_BUCKET` | `foxtrot-replays-prod` |
   | `S3_REGION` | `us-east-1` |

   Do **not** set `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` on EB — the
   SDK uses the instance role (default credential chain). Do not set
   `S3_ENDPOINT` or `REPLAY_STORAGE_DIR` in production.

5. First deploy: push to `main` with the GitHub secrets configured (§8) and
   let `deploy-api.yml` do ECR push + `create-application-version` +
   `update-environment`. (Manual alternative: build/push the image yourself
   and upload a `Dockerrun.aws.json` zip — the workflow's "Deploy to Elastic
   Beanstalk" step shows the exact shape.)

### Socket.io / single-port note

API and Socket.io are being consolidated onto the **same port (3001)**
(in-flight change; the current dev code still binds Socket.io to
`PORT+1=3002`). Once consolidated, EB single-instance needs no special
config: one container port, websockets upgrade on the same listener.

If you later scale to **more than one instance** behind an ALB:

- Enable **sticky sessions** on the target group (Socket.io HTTP
  long-polling handshakes must hit the same instance; with
  `transports: ['websocket']` only, stickiness is not strictly required).
- Multi-instance Socket.io also needs the Redis adapter
  (`@socket.io/redis-adapter`) so events reach sockets on other instances —
  follow-up feature; Redis is already provisioned.

EB health checks: single-instance EB pings the container port. There is no
dedicated `/health` route yet (follow-up); any HTTP response (even a 404
from `/`) proves liveness for the basic check. When moving to ALB health
checks, add a real `/health` endpoint first and point the target group at it.

## 6. SES (email — SHIPPED)

Email is live: `apps/api/src/lib/email.ts` uses `@aws-sdk/client-ses` (region
pinned us-east-1, credentials from the EB instance role). It sends only when
`SES_FROM_EMAIL` is set (otherwise it logs to the console — the dev fallback).
Used for password-reset links today; account notifications as they land.

**Required IAM — do not skip.** The EB instance role
`aws-elasticbeanstalk-ec2-role` MUST allow `ses:SendEmail`. Without it every
send fails with `403 AccessDenied`, and because `/forgot-password` swallows the
error and always returns `{ok:true}`, it looks like nothing is wrong while **no
mail goes out**. This was a real production gap, fixed 2026-06-13 by attaching
the inline policy `foxtrot-ses-send`:

```json
{ "Version": "2012-10-17",
  "Statement": [ { "Sid": "FoxtrotSesSend", "Effect": "Allow",
    "Action": ["ses:SendEmail", "ses:SendRawEmail"], "Resource": "*" } ] }
```

Apply with `aws iam put-role-policy --role-name aws-elasticbeanstalk-ec2-role
--policy-name foxtrot-ses-send --policy-document <above>`. It is **CLI-applied,
not in IaC — re-add it if the instance role is ever recreated.** (Optional
hardening: scope `Resource` or add a `ses:FromAddress` condition once you've
confirmed sends still succeed.)

**Sandbox / production access — BACKLOGGED.** The account is still in the SES
**sandbox**: it can only deliver to *verified* identities (the domain
`randallsnightly.com` and any individually-verified address — a non-verified
recipient gets `MessageRejected: Email address is not verified`). The
production-access request (**case 178127710500151**) was **DENIED**, so
real-user email stays blocked until it is re-requested and granted. Re-request
via `aws sesv2 put-account-details ProductionAccessEnabled=true` with a stronger
transactional/opt-in use-case writeup (or reply to the case in the Support
console). **Deliberately on the backlog — do not resubmit without sign-off.**
Interim: verify individual test recipients with `aws sesv2 create-email-identity`.

## 7. CloudFront + Route53 + ACM

### Certificates (ACM)

- **us-east-1** (required for CloudFront): request a public cert for
  `yourdomain.gg` + `www.yourdomain.gg`, DNS validation via Route53.
- **EB region** (e.g. us-east-1 anyway): a cert for `api.yourdomain.gg`
  if you terminate TLS at an ALB. **Single-instance EB has no ALB** — the
  simplest start is to route api calls *through CloudFront* (below), which
  gives you TLS at the edge without an ALB.

### CloudFront distribution (web + api through one domain)

The web app calls the api with a **relative** `baseURL: "/api"`
(`apps/web/src/lib/api.ts`), so the cleanest setup serves both through the
same CloudFront domain — no CORS, no rebuild per environment:

1. Create a distribution, alternate domain `yourdomain.gg`, the us-east-1
   ACM cert.
2. **Origin A**: the web S3 bucket with **Origin Access Control** (CloudFront
   console offers to attach the bucket policy — accept).
3. **Origin B**: the EB environment URL
   (`foxtrot-api-prod.xxxx.us-east-1.elasticbeanstalk.com`, HTTP-only origin
   on the simple start; switch to HTTPS origin when EB has a cert).
4. Behaviors:
   | Path | Origin | Policy |
   |---|---|---|
   | `/api/*` | EB | CachingDisabled + AllViewerExceptHostHeader origin-request policy, allow all HTTP methods |
   | `/socket.io/*` | EB | same as above (websockets are supported by CloudFront) |
   | Default `(*)` | S3 web | CachingOptimized |
5. **SPA fallback**: a CloudFront Function on the default behavior's
   viewer-request rewrites extensionless non-API paths to `/index.html`.
   (Do NOT use distribution-wide custom error responses for this — they
   would also rewrite legitimate API 403/404 JSON responses to index.html
   with HTTP 200, which breaks API clients including the game.)
6. Route53: `A`/`AAAA` alias `yourdomain.gg` → the distribution.
7. Optional `api.yourdomain.gg` (direct-to-EB, useful for webhooks/devices):
   either a second CloudFront distribution in front of EB, or — once on an
   ALB — a Route53 alias straight to the ALB with the regional ACM cert.
   Point the Stripe webhook at whichever hostname serves `/api/webhooks`.

Web build-time URLs in this setup:

- `VITE_API_URL` — currently unused (the axios base is hardcoded `/api`);
  leave empty.
- `VITE_SOCKET_URL` — set to `https://yourdomain.gg` once Socket.io is
  consolidated behind `/socket.io/*`; today (dev) it is `http://localhost:3002`.
- `VITE_STRIPE_PUBLISHABLE_KEY` — the live publishable key.

### Production values (as built, 2026-06-12)

| Thing | Value |
|---|---|
| Domain | `randallsnightly.com` (Route53-registered, privacy on, auto-renew; hosted zone `Z03490391XST8MEOGEUVZ`) |
| ACM cert (us-east-1) | `arn:aws:acm:...:826671498662:certificate/23d2589e-78d7-47a3-a676-24b51fe9856f` — `randallsnightly.com` + `*.randallsnightly.com`, ISSUED |
| CloudFront distribution | `E2J2AGBK1BOAMP` (`d3kbmthjr8ssji.cloudfront.net`); aliases apex + `www`; HTTP/2+3; PriceClass_100 |
| SPA rewrite | CloudFront Function `randallsnightly-spa-rewrite` (viewer-request, default behavior only) |
| S3 web origin | `foxtrot-web-826671498662` via OAC `E3VY7642M14Z6R`; bucket policy is CloudFront-only, public access fully blocked (the old S3 static-website URL is dead — intentional) |
| EB origin | `foxtrot-api-prod.eba-npsz5ez5.us-east-1.elasticbeanstalk.com`, http-only, behaviors `/api/*`, `/socket.io/*`, `/health` (CachingDisabled + AllViewerExceptHostHeader) |
| DNS | A/AAAA aliases apex + www → the distribution; ACM validation CNAME; SES DKIM ×3 (verified); `_dmarc` TXT `p=none` |
| SES | domain `randallsnightly.com` + `robert.liam.walker@gmail.com` VERIFIED; `SES_FROM_EMAIL=no-reply@randallsnightly.com` on EB; instance-role `ses:SendEmail` via inline policy `foxtrot-ses-send` (added 2026-06-13 — see §6); production access **DENIED** (case 178127710500151) → sandbox-only, re-request BACKLOGGED |
| EB env | `WEB_URL=https://randallsnightly.com` set 2026-06-12 |
| GH Actions vars | `VITE_API_URL=https://randallsnightly.com/api`, `VITE_SOCKET_URL=https://randallsnightly.com`, `CLOUDFRONT_DISTRIBUTION_ID=E2J2AGBK1BOAMP` (deploy-web invalidates on every deploy) |
| Match rendezvous (UDP) | Deploy bundle is **docker-compose** (EB compose mode: no managed nginx — the container publishes `80:3001` itself — and env properties arrive via the EB-generated `.env`). Ports `80:3001` + `41100:41100/udp`. EB env props `RENDEZVOUS_HOST=rdv.randallsnightly.com`, `RENDEZVOUS_UDP_PORT=41100` (HOST is what `/ready` advertises to clients; the socket binds 0.0.0.0). `rdv.randallsnightly.com` A → the single-instance EIP **directly** (CloudFront cannot proxy UDP — bypassed by design; if EB ever scales out, move the registrar to a dedicated instance or NLB-UDP). SG: UDP 41100 ingress from 0.0.0.0/0 on the EB instance SG. Registrar drops malformed/unknown packets silently (anti-reflector) — a from-outside preflight needs real `/ready` tokens; packet arrival shows in app logs as `rdv packet rejected` |

## 8. GitHub Actions configuration

Create an IAM user `foxtrot-deployer` (access key auth; switch to GitHub
OIDC later) with: `AmazonEC2ContainerRegistryPowerUser`,
`AdministratorAccess-AWSElasticBeanstalk`, S3 write to the web bucket + the
EB artifacts bucket, and `cloudfront:CreateInvalidation`.

Repo **Secrets** (Settings → Secrets and variables → Actions):

| Secret | Used by | Notes |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | deploy-api, deploy-web | absence = both deploys skip cleanly |
| `AWS_SECRET_ACCESS_KEY` | deploy-api, deploy-web | |
| `VITE_STRIPE_PUBLISHABLE_KEY` | deploy-web | publishable (not actually secret) |

Repo **Variables**:

| Variable | Default if unset | Used by |
|---|---|---|
| `AWS_REGION` | `us-east-1` | both deploys |
| `ECR_REPOSITORY` | `foxtrot-api` | deploy-api |
| `EB_APPLICATION` | `foxtrot` | deploy-api |
| `EB_ENVIRONMENT` | `foxtrot-api-prod` | deploy-api |
| `WEB_S3_BUCKET` | — (**required**, deploy skips without it) | deploy-web |
| `CLOUDFRONT_DISTRIBUTION_ID` | — (invalidation skipped if empty) | deploy-web |
| `VITE_API_URL` | empty (relative `/api`) | deploy-web |
| `VITE_SOCKET_URL` | empty | deploy-web |

`ci.yml` needs no secrets and runs on every push/PR.

## 9. API environment variable matrix

Enumerated from `apps/api/.env.example` + `process.env.*` across
`apps/api/src` and `prisma/` as of this writing. Other agents are adding
features concurrently — **the final matrix is consolidated by the
orchestrator**; treat additions in their PRs as authoritative.

| Variable | Required in prod | Source/notes |
|---|---|---|
| `DATABASE_URL` | yes | RDS (Prisma datasource), EB env prop |
| `REDIS_URL` | yes | ElastiCache, EB env prop |
| `JWT_SECRET` | yes | random 64+ chars; **must be rotated** (§0); api falls back to a dev value if unset — never allow that in prod |
| `PORT` | yes (`3001`) | container listen port |
| `WEB_URL` | yes | CORS origin, Socket.io CORS, Stripe success/cancel redirect URLs |
| `NODE_ENV` | yes (`production`) | set by the Dockerfile |
| `PAID_EVENTS_ENABLED` | optional | `"true"` enables paid event scheduling/registration |
| `STRIPE_SECRET_KEY` | yes | rotated live key |
| `STRIPE_WEBHOOK_SECRET` | yes | per webhook endpoint |
| `STRIPE_PRICE_ID` | yes | live recurring price |
| `S3_BUCKET` | yes (prod) | enables S3 replay storage; unset = local disk |
| `S3_REGION` | yes with S3 | falls back to `AWS_REGION`, then `us-east-1` |
| `S3_ENDPOINT` | no (local minio/localstack only) | non-AWS endpoints get path-style addressing |
| `AWS_REGION` | implicit on EB | default SDK chain |
| `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` | **no on EB** (instance role) | only for local S3 testing |
| `REPLAY_STORAGE_DIR` | no | dev override for the local-disk root |

## 10. Launch checklist

- [ ] `apps/api/.env` untracked + **all secrets rotated** (§0)
- [ ] `prisma/migrations/` baseline committed **and removed from `.gitignore`**
- [ ] RDS reachable from EB only; `DATABASE_URL` env prop set
- [ ] Redis reachable from EB only; `REDIS_URL` env prop set
- [ ] Replays bucket + instance-role policy; `S3_BUCKET` set; upload a replay end-to-end
- [ ] EB env green; logs show `migrate deploy` ran (or skipped pre-baseline)
- [ ] CloudFront serving the web bucket; `/api/*` behavior hits EB; SPA fallback works on deep links
- [ ] Stripe webhook endpoint pointed at the public `/api/webhooks/...` URL and signing secret set
- [ ] SES production access requested (email feature pending)
- [ ] GitHub secrets/vars set; a push to `main` deploys api + web
