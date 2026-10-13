# Disaster Recovery & Encrypted Backup Policy

**Current state (2026-10-14):** Production design approved (Review C6, F3, Deployment step 19c).
Applies to hosted production environments in accordance with SRA Code of Conduct,
UK GDPR Article 32 (Security of Processing), and Legal Professional Privilege (LPP).

---

## 1. Recovery Objectives (RPO & RTO)

| Metric | Target | Rationale & Mechanism |
|---|---|---|
| **RPO (Recovery Point Objective)** | **≤ 15 minutes** | Managed PostgreSQL continuous Write-Ahead Log (WAL) archiving to secondary object storage, supplemented by synchronous replica in secondary Availability Zone (AZ). |
| **RTO (Recovery Time Objective)** | **≤ 4 hours** | Automated multi-AZ failover (< 60s for zone failure); full cold-site restore runbook from immutable encrypted snapshots (< 4 hours for catastrophic multi-zone outage). |

---

## 2. Storage & Backup Encryption (Review C6)

### Storage at Rest
1. **Host Disks:** All primary databases, web servers, and temporary volumes employ AES-256 hardware/kernel-level block encryption (LUKS on Linux, managed KMS-encrypted EBS/Managed Disks).
2. **Encrypted S3 Object Storage:** SeaweedFS/S3 document and evidence stores enforce server-side encryption (SSE-KMS) with dedicated customer-managed keys (CMKs) in addition to envelope application-level encryption (`DOCUMENT_ENCRYPTION_KEY`, `HR_ENCRYPTION_KEY`, `SUSPICION_ENCRYPTION_KEY`).

### Backup Encryption & Off-Site Replication
1. **Air-Gapped & Immutable:** Daily PostgreSQL physical base backups and WAL archives stream directly to a hardened, access-restricted secondary bucket with **Object Lock (Compliance Mode / WORM)** enabled to prevent ransomware destruction or tampering.
2. **Encryption Keys:** Backups are encrypted with asymmetrical GPG keys / AWS KMS keys whose decrypt permission is restricted to emergency break-glass disaster recovery roles.
3. **UK Jurisdiction:** Backups reside strictly within UK/EEA data centers:
   - Primary: UK South (London / England).
   - Secondary DR Backup Target: UK West (Cardiff / Wales) or EU West (Dublin / Ireland).

---

## 3. Retention & Disposal Replay Rule

> [!CRITICAL]
> **A backup restore must never resurrect lawfully disposed personal data.**
> Under UK GDPR Article 17 and MLR 2017 Regulation 40, personal data disposed of under
> AML or HR retention procedures must not be returned to live circulation via a database restore.

### Post-Restore Disposal Replay Procedure
Following any restore from a backup image:
1. **Network Quarantine:** The restored database remains quarantined; external traffic to the API and Web apps is blocked.
2. **Audit Extraction:** The system inspects immutable audit entries in `app.audit_events` created between the backup timestamp and the outage:
   - `action = 'aml.retention_disposed'`
   - `action = 'hr.retention_disposed'`
3. **Tombstone Replay:** For every disposal recorded after the backup point:
   - Live CDD, matter, individual, or HR personal data rows are purged.
   - Content-free cryptographic tombstones are reapplied.
   - S3 object deletion verification is re-executed.
4. **Supervisory Sign-Off:** The Compliance Officer (COLP/MLRO) and Lead Partner verify that no disposed personal data is live before DNS traffic is routed to the restored instance.

---

## 4. Backup Lifecycle & Schedules

| Backup Type | Frequency | Retention Window | Immutability |
|---|---|---|---|
| **Continuous WAL** | Every 15 min | 14 days | Append-only, strict IAM lock |
| **Daily Full Snapshot** | Every 24 hours (02:00 UTC) | 30 days | Object Lock (30-day WORM) |
| **Weekly Snapshot** | Sundays | 90 days | Object Lock (90-day WORM) |
| **Monthly Snapshot** | 1st of month | 12 months | Object Lock (1-year WORM) |

---

## 5. Restoration Runbook (Verification Drill)

### Step 1: Prepare Isolated Restoration Environment
```bash
# Provision isolated VPC/staging database target
export RESTORE_TARGET_HOST="10.0.99.10"
export RESTORE_POINT_IN_TIME="2026-10-14 01:00:00+00"
```

### Step 2: Restore PostgreSQL Base Image & Replay WAL
```bash
# Fetch encrypted base backup and decrypt via KMS
aws s3 cp s3://pms-backups-immutable/base-2026-10-14.tar.gz.enc - | \
  gpg --decrypt --batch --passphrase-file /etc/pms/dr-key | \
  tar -xz -C /var/lib/postgresql/data

# Configure recovery.signal with target recovery point
cat <<EOF > /var/lib/postgresql/data/recovery.signal
restore_command = 'aws s3 cp s3://pms-backups-immutable/wal/%f %p'
recovery_target_time = '${RESTORE_POINT_IN_TIME}'
recovery_target_action = 'promote'
EOF
```

### Step 3: Run Database Migrations & Validation
```bash
# Start PostgreSQL in recovery mode and verify consistency
systemctl start postgresql
npm run --prefix apps/api migrate
```

### Step 4: Replay Post-Backup Retention Disposals
```bash
# Execute automated disposal replay verification script
npm run --prefix apps/api retention:sweep
```

### Step 5: Verify Integrity & Release
```bash
# Run read-only healthcheck suite
curl -f http://127.0.0.1:3001/api/health
```

---

## 6. Drill Schedule

A full cold-site restore drill is conducted **every 6 months** by the technical team and recorded in `docs/reviews/`. Results, RTO/RPO achieved, and sign-offs are submitted to the firm's Risk and Compliance Committee.
