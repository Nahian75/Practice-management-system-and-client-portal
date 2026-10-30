# Deploy Stass on Render

Render is the prepared managed-hosting option. You do not need to maintain a Linux server or install Docker on your own computer to deploy it. Upload the source to a private Git repository and connect it to Render.

The root `render.yaml` creates the public Next.js website with a streaming gateway, a private NestJS API, a private antivirus scanner with persistent definitions, and daily security cleanup. Use a paid Render PostgreSQL database, private S3-compatible file storage and an SMTP provider alongside these services. These resources have hosting costs; review Render's creation summary before deployment.

The existing local demo is separate. This configuration starts an empty hosted database and invites your administrator. It does not upload local accounts, client records or files.

## 1. Prepare the database, storage and email

In Render, create a **paid PostgreSQL 18** database in **Frankfurt**, with database name `pms`. Start with at least 1 GB database RAM and enable the backup/recovery options you need. Keep the provider's generated database administrator user; do not name it `pms_owner` or `pms_app`. Copy its **External Database URL** privately. This is the connection value requested by the Blueprint.

The external endpoint is deliberate: this app verifies both the database certificate and hostname. Render's internal self-signed database endpoint does not support this verification mode. The code adds `sslmode=verify-full` and refuses insecure fallback. Restrict database external access to your Render services' outbound IP ranges using Render's database access controls. Include both API and cron job outbound ranges. Do not paste credentials into Git or chat.

Create a **private** S3-compatible bucket, such as Cloudflare R2 or AWS S3. Obtain its HTTPS S3 API endpoint, bucket name, access key and secret. Use credentials scoped to that bucket with object read/write/delete/list and bucket metadata access. Public bucket access is unnecessary: document access stays behind the application and files are encrypted before storage. The template defaults to R2's `auto` region; for AWS S3, change `DOCUMENTS_S3_REGION` on `stass-api` to the bucket's real region before deploying.

Choose an SMTP provider and verify your sending domain/address. Obtain an authenticated SMTP URL, for example `smtps://username:percent-encoded-password@smtp.provider.example:465`. Alternatively use a provider's STARTTLS port with `smtp://`. Production requires encrypted email transport. A normal email address alone is not an SMTP service.

## 2. Connect the source and create the Blueprint

1. Put the current release source in your **private Git repository**. You can extract `docs/stass-hosting-release.tar.gz` into a new repository; it contains the current application and both hosting options. Do not add `.env` files or local demo credentials. The release archive includes `.gitignore`.
2. In `render.yaml`, change the public service name `stass` to a unique name for your practice, for example `your-practice-portal`. Leave `stass-api`, `stass-scanner` and their references as they are. The public address will normally be `https://your-practice-portal.onrender.com`; use a name that is available on Render. Existing resources with the same names may be updated by a Blueprint, so use a dedicated workspace/project or check for name collisions.
3. In Render choose **New → Blueprint**, connect the repository and select `render.yaml`.
4. Supply the requested values listed below. Check the paid resources and create the Blueprint.

| Requested setting | Value |
| --- | --- |
| `CLOUD_ADMIN_DATABASE_URL` | Your database's external connection URL, kept secret |
| `CLOUD_APP_BASE_URL` | The exact HTTPS address users will open, e.g. `https://your-practice-portal.onrender.com` |
| `ADMIN_EMAIL` | Your first administrator's email address |
| `ADMIN_NAME` | That person's display name |
| `SMTP_URL` | Your provider's authenticated SMTP URL |
| `MAIL_FROM_ADDRESS` | Your provider-verified sender email |
| `DOCUMENTS_S3_ENDPOINT` | HTTPS S3 API endpoint, without the bucket name |
| `DOCUMENTS_S3_BUCKET` | The private bucket's name |
| `DOCUMENTS_S3_ACCESS_KEY` | Bucket access key |
| `DOCUMENTS_S3_SECRET_KEY` | Bucket secret key |

The Blueprint generates `CLOUD_ROOT_KEY` once. The application derives separate encryption keys and the two restricted database-role passwords from it using HKDF-SHA256 with distinct purpose labels. **Back up this exact secret securely alongside your recovery information.** Do not replace or regenerate it on redeployment. Changing it would make encrypted records unreadable; pre-deploy checks reject a changed secret for an existing deployment. The Linux-server package uses its own independent keys; its data is not automatically interchangeable with this deployment.

The pre-deploy step creates the restricted roles and schemas, installs `pg_trgm` and `unaccent`, applies migrations as the schema owner, then sends one administrator invitation if no staff account exists. The running API uses `pms_app`; the bootstrap database URL and root secret are removed before executing the API process. Bootstrap requires a provider administrator that can create roles/extensions and grant their membership; the bootstrap fails if those permissions are missing. It never switches normal application access to the provider administrator.

## 3. Open and verify the application

Wait for the website, API and scanner to finish their first deployments. Initial antivirus definitions can take several minutes to download. Accept the administrator invitation from your real email inbox, set your password, enrol an authenticator, and save the backup codes. The first account receives Administrator, Partner and Compliance roles. Invite separate staff for routine work and independent approvals.

In the **stass-api → Shell** panel run:

```sh
node /app/infra/hosting/cloud-runtime.mjs verify
```

This checks verified database TLS, authenticated file storage, the antivirus scanner and encrypted SMTP without sending a test email. Also check login/logout, password-reset delivery, document upload/download, and the intended staff/client permissions through the hosted URL. `/api/health` checks the API, but does not prove that all external services are configured correctly.

Only the public website receives an internet URL. API and scanner traffic uses the Render private network. Browser uploads bypass the Next.js proxy and stream directly through the gateway to the API, keeping the existing 50 MB document limit and the same-origin cookie/CSRF protections. The API trusts private-network proxies; use a dedicated Render environment without unrelated, untrusted services. The gateway reads Render's forwarded client address only from private ingress connections and replaces forwarding headers before sending them to the API. Verify distinct client addresses in audit/sign-in events after deployment.

## Updates, custom domains and recovery

Push reviewed changes to the linked deployment branch. Render rebuilds the containers and the API pre-deploy step applies pending migrations. Existing accounts and keys remain in place. Run the verification command again after changing provider credentials or infrastructure.

Add your domain under **stass → Settings → Custom Domains**, follow Render's DNS instructions, wait for the managed HTTPS certificate, then set `CLOUD_APP_BASE_URL` on `stass-api` to the new `https://...` origin. Redeploy the API and sync the Blueprint so the cleanup job's referenced setting updates. If you set an explicit `APP_BASE_URL` override, keep it consistent. Invitation/reset links use this setting.

The daily `stass-security-cleanup` cron job removes only expired ephemeral security records using the existing retention policy. AML, matter, finance and HR disposal remains controlled in the application. If a cron run fails because it preceded the first API deployment, run it again after the API is healthy.

Back up the database, document objects and the original deployment secret. Render database backups do not back up an external bucket or encryption keys. Enable object versioning/recovery where your storage provider supports it, establish retention, and test restoration using [Disaster recovery](disaster-recovery.md), including post-restore privacy tombstones. Paid hosting and a successful build alone do not establish a tested production recovery process.

## Why this setup uses Render instead of Vercel alone

Vercel supports the Next.js frontend, but this application also runs a persistent NestJS API, scheduled work and a private ClamAV daemon. Its current document flow permits 50 MB files; Vercel Functions limit request/response payloads to 4.5 MB. Hosting only the frontend on Vercel would require additional routing and verification. The prepared Render deployment keeps one public origin and runs the existing services together.

Provider references: [Render Blueprints](https://render.com/docs/blueprint-spec), [private services](https://render.com/docs/private-services), [database TLS](https://render.com/docs/postgresql-creating-connecting), [extensions](https://render.com/docs/postgresql-extensions), [forwarded client IP](https://render.com/articles/how-render-handles-ddos-attacks), [Vercel Function limits](https://vercel.com/docs/functions/limitations).
