# AWS scaling setup

This is a prepared, locally validated **application scaling stack**, not an AWS
deployment or a cloud performance certificate. It uses ECS Fargate containers so
AWS can add copies without requiring you to maintain an EC2 operating system.
No AWS resources are created by the generator, parameter checker or local tests.

## Architecture

Internet -> HTTPS Application Load Balancer + WAF -> 2 to 4 private application tasks
-> existing private RDS PostgreSQL 18 and private S3. Each task runs the same API,
Next.js gateway and fresh ClamAV sidecar. Tasks share database sessions, quotas,
durable queues, scheduling state and **the same encryption-key versions**.

Tasks use private subnets with working outbound NAT. Only the ALB can reach gateway
port 10000. API 3001 and scanner 3310 listen within the task network; neither has
an internet listener. RDS permits port 5432 from the task security group. The gateway
normalizes the ALB forwarding chain; the API trusts only its loopback gateway.
The edge assumes visitors connect directly to the ALB, not through an unconfigured
additional CDN/proxy. TLS 1.3 is required at the public listener.

## Prerequisites to provision separately

- One firm per isolated deployment: dedicated VPC/resources, PostgreSQL database,
  private bucket, keys and secrets. Shared-database SaaS tenancy is not implemented.
- VPC with two public ALB subnets and two private app subnets in different AZs;
  private subnets need NAT/appropriate endpoints for ECR, logs, Secrets Manager,
  antivirus updates, SMTP and sanctioned list downloads. NAT has separate costs.
- Private RDS PostgreSQL 18, encryption, backups/PITR and tested restore. Choose
  Multi-AZ for availability where required. RDS processing/storage scaling is
  separate from app-task scaling; standby failover is not a read-scaling strategy.
- Restricted pms_owner migration role and pms_app runtime role, schemas/extensions
  and default privileges matching the prepared hosting setup. Use a fresh database
  and an administrator-controlled bootstrap. Never put an RDS administrator URL
  in the runtime secret. See ../hosting/postgres-init/01-production.sh for the
  role/schema/extension policy; do not run that container shell verbatim on RDS.
- Private S3 bucket, verified SMTP sender, ACM certificate in the ALB's region,
  confirmed SNS alert destination and private ECR image repositories.
- Review AWS resource costs: ALB, WAF, Fargate, NAT, RDS, S3, Secrets Manager,
  CloudWatch and data transfer are not a permanently free production deployment.

## Secrets

Create TWO Secrets Manager JSON secrets. Runtime JSON must contain DATABASE_URL
(pms_app with sslmode=verify-full), all seven purpose ENCRYPTION_KEY values,
ENCRYPTION_KEY_VERSION ("1" initially), PREVIOUS_ENCRYPTION_KEYS ("{}" initially),
SMTP_URL, MAIL_FROM_ADDRESS, DOCUMENTS_S3_ENDPOINT, DOCUMENTS_S3_REGION,
DOCUMENTS_S3_BUCKET, DOCUMENTS_S3_ACCESS_KEY and DOCUMENTS_S3_SECRET_KEY.
Use independently generated 32-byte base64 purpose keys and bucket-scoped storage
credentials. Retain required key versions for every active replica and backup.
Store only MIGRATION_DATABASE_URL (pms_owner, verify-full) in the migration secret.
Optional customer-managed encryption for these secrets uses SecretsKmsKeyArn.

The application execution role can retrieve only the runtime secret; migration
execution can retrieve only its own secret. The running task IAM role has no AWS
service permissions. The service never receives migration/admin credentials.
Do not grant task IAM permissions to fetch or modify arbitrary secrets.

The API image includes AWS's PUBLIC RDS CA bundle at /app/infra/aws/rds-ca.crt,
loaded with NODE_EXTRA_CA_CERTS. Source: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem.
Retrieved 31 October 2026 (Asia/Dhaka); 114 public certificates; SHA-256
90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b.
This is not a private key. Maintain the bundle ahead of provider CA rotation.

## Prepare and review

1. Build/push the API using root Dockerfile target api, and gateway using
   infra/hosting/render-web.Dockerfile. Supply immutable ECR SHA-256 image digests,
   never mutable latest tags. All replicas of a release use the same builds.
2. Generate app-scaling.json with `node infra/aws/app-stack.mjs`.
3. Create a CloudFormation parameter JSON array (ParameterKey/ParameterValue).
   Fill the required VPC/subnet/group IDs, domain, certificate, image digests,
   separate secret ARNs and alarm SNS ARN. Keep EnableService=false initially.
4. Run `node scripts/scaling/check-aws-parameters.mjs parameters.json`.
   Optionally add --check-database with SCALING_DATABASE_URL securely supplied
   as the pms_app URL and the CA bundle enabled. This is a read-only TLS/capacity
   check. It does not create AWS resources or reveal secret values.
5. Validate the template with cfn-lint and review an AWS CloudFormation change set,
   IAM changes and costs before an authorized operator executes it. Initial stack
   creation still provisions paid ALB/WAF resources even with the app disabled.

## Connection budget and vertical scaling

Defaults: two warm tasks, maximum four desired tasks, API pool five per task,
database budget 100 and twenty reserved connections. Rolling deployment can run
twice the maximum task count: 8 * 5 + 20 = 60 required connections. The generator
maps MaxReplicas to the surge allowance. The preflight and API startup reject an
insufficient budget. Startup also checks PostgreSQL max_connections and the login
role's connection limit. Some prepared bootstraps cap pms_app at fifty; raising
MaxReplicas may require a reviewed role-limit change, not merely a larger DB.

TaskCpu/TaskMemory change CPU and memory through a new task definition and rolling
deployment. Supported pairs are validated. More CPU helps scanner/native workloads;
one Node.js JavaScript event loop does not automatically use every CPU core. Use
replicas for additional JS processes. RDS class/storage changes require their own
maintenance, recovery and performance plan. Storage autoscaling does not add DB CPU.

## Migrate, enable and verify

Create the reviewed stack with EnableService=false. Run its MigrationTask once
using the private subnets/task security group and no public IP. Wait for STOPPED
and verify migration-container exitCode=0; failure blocks enabling the application.
Do not run migrations independently on each app replica. Runtime images must remain
compatible with the previous schema during rollout; use expand/contract changes.

Update the same stack with EnableService=true only after migrations and capacity
preflight pass. Service creation then enables two healthy targets, CPU/memory target
tracking and bounded scale-out. Set DNS to the ALB and verify the HTTPS hostname.
Use OperationsTask with an explicitly reviewed container command override to invite
the first administrator through dist/cli/invite.js. The default operations command
fails safely and performs no invitation. Keep credentials out of command arguments.

Verify login/MFA, office-IP traffic, upload/scanning/download, quotas, actual client
addresses, SMTP delivery, security alerts and shutdown/failover in AWS staging.
Local fixture health probes/retries do not establish ALB failure timing or retries.
Tune scaling triggers using measured CPU, memory, queue depth, response time and
errors. ClamAV cold downloads can take minutes: keep warm tasks and measure scale-out
startup rather than promising instant added capacity. Readiness fails closed while
definitions or storage are unavailable. Target draining is 90 seconds; containers
have a 120-second stop timeout. Long transfers can still exceed those limits.

## Distributed work and release limits

Mail uses leased database claims and deduplication; reminders use database locking
and unique keys. SMTP delivery remains at least once: a crash after SMTP acceptance
but before acknowledgement can cause a retry. Do not promise exactly-once email.
Sanctions refresh uses a reserved PostgreSQL session advisory lock and durable due
times. Imports atomically wake durable rescreening; retries select only subjects
missing a current screening. Process death releases session ownership when the DB
detects the disconnect. Use DIRECT/session-persistent PostgreSQL connections;
transaction-mode poolers are unsupported for these locks. Network partitions still
need a cloud failure exercise and monitoring for missed jobs.

Each rollout must retain old immutable Next.js static assets long enough for open
clients, or use a verified version-routing/blue-green release procedure. This stack
provides rolling task replacement, not a tested cross-version browser compatibility
guarantee. Do not remove old assets or assume a successful health probe proves a
mixed-version release works. That release exercise remains a production gate.

The stack attaches existing data services; it does not create their backups,
independent audit Object Lock store, contracts or legal sign-off. Follow the main
security operations and recovery runbooks before live client records.

References: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html
and https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html.
