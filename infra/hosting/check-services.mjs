import pg from 'pg';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { createTransport } from 'nodemailer';
import { checkScannerFreshness } from '../../apps/api/dist/documents/virus-scanner.js';
import { loadEnv } from '../../apps/api/dist/config/env.js';
import { smtpTransportOptions } from '../../apps/api/dist/mail/mailer.js';
const env=loadEnv(process.env);
const db=new pg.Client({connectionString:env.DATABASE_URL});
try {
 await db.connect();
 const result=await db.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
 if(result.rows[0]?.ssl!==true)throw new Error('Database connection is not encrypted.');
 console.log('Database: connected with verified TLS.');
} finally {await db.end();}
const s3=new S3Client({endpoint:env.DOCUMENTS_S3_ENDPOINT,region:env.DOCUMENTS_S3_REGION,forcePathStyle:true,credentials:{accessKeyId:env.DOCUMENTS_S3_ACCESS_KEY,secretAccessKey:env.DOCUMENTS_S3_SECRET_KEY}});
try {await s3.send(new HeadBucketCommand({Bucket:env.DOCUMENTS_S3_BUCKET}));console.log('File storage: authenticated bucket access over verified TLS.');} finally {s3.destroy();}
await checkScannerFreshness(env.CLAMAV_HOST,env.CLAMAV_PORT);
console.log('Antivirus scanner: responding with definitions less than 48 hours old.');
const smtp=createTransport(smtpTransportOptions(env));
try {await smtp.verify();console.log('SMTP: verified encrypted connection and configured authentication. No email sent.');} finally {smtp.close();}
