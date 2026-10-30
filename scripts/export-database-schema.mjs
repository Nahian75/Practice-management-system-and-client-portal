import pg from 'pg';
import ts from 'typescript';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { databaseExplorer } from './database-explorer.mjs';

const root = resolve(import.meta.dirname, '..');
process.loadEnvFile(resolve(root, 'apps/api/.env'));
if (!process.env.MIGRATION_DATABASE_URL) throw new Error('Local database settings are missing.');
const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
const rows = async sql => (await client.query(sql)).rows;
const groups = [
  ['Identity & access', /^(accounts|account_roles|sessions|sign_in_failures|totp_credentials|backup_codes|invitations|password_resets)$/],
  ['Audit & notifications', /^(audit_events|notifications|notification_.*|email_outbox.*|task_reminders)$/],
  ['People & HR', /^hr_/], ['AML & compliance', /^aml_/], ['AI drafting', /^ai_/],
  ['Clients & onboarding', /^(clients|client_individuals|client_organisations|client_contacts|client_responsibility_changes|contact_verification.*|conflict_(aliases|connected.*|decisions|decision.*)|onboarding_.*|engagement_.*|policy_.*|firm_policy_.*|client_onboarding_.*|identity_.*|company_.*|matter_fee_estimate.*|matter_budget.*|initial_payment_.*)$/],
  ['Documents & portal', /^(documents|document_.*|portal_.*)$/],
  ['Matters & tasks', /^(matters|matter_(team.*|parties|closures|compliance_accesses|supervision_takeovers)|conflict_checks|conflict_clearances|tasks|task_.*)$/],
];
const domain = name => groups.find(([, pattern]) => pattern.test(name))?.[0] ?? 'Finance & billing';
await client.connect();
let schema;
try {
  // Every database operation below is a catalog SELECT in a read-only snapshot.
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const tables = await rows(`SELECT c.relname AS name, c.relrowsecurity AS row_security,
    obj_description(c.oid,'pg_class') AS description
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='app' AND c.relkind IN ('r','p') ORDER BY c.relname`);
  const columns = await rows(`SELECT c.relname AS table_name,a.attname AS name,a.attnum AS position,
    format_type(a.atttypid,a.atttypmod) AS type,NOT a.attnotnull AS nullable,
    pg_get_expr(d.adbin,d.adrelid) AS default_expression,
    col_description(c.oid,a.attnum) AS description
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='app' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attnum`);
  const constraints = await rows(`SELECT c.relname AS table_name,co.conname AS name,co.contype AS kind,
    co.convalidated AS validated,co.condeferrable AS deferrable,pg_get_constraintdef(co.oid,true) AS definition,
    f.relname AS referenced_table,fn.nspname AS referenced_schema,
    ARRAY(SELECT a.attname::text FROM unnest(co.conkey) WITH ORDINALITY k(num,ord)
      JOIN pg_attribute a ON a.attrelid=co.conrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,
    ARRAY(SELECT a.attname::text FROM unnest(co.confkey) WITH ORDINALITY k(num,ord)
      JOIN pg_attribute a ON a.attrelid=co.confrelid AND a.attnum=k.num ORDER BY k.ord) AS referenced_columns
    FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_class f ON f.oid=co.confrelid LEFT JOIN pg_namespace fn ON fn.oid=f.relnamespace
    WHERE n.nspname='app' ORDER BY c.relname,co.conname`);
  const indexes = await rows(`SELECT c.relname AS table_name,idx.relname AS name,i.indisunique AS unique,
    i.indisvalid AS valid,am.amname AS method,pg_get_indexdef(i.indexrelid) AS definition,
    pg_get_expr(i.indpred,i.indrelid) AS predicate,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(num,ord)
      LEFT JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num
      WHERE k.ord<=i.indnkeyatts ORDER BY k.ord) AS columns
    FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_am am ON am.oid=idx.relam
    WHERE n.nspname='app' ORDER BY c.relname,idx.relname`);
  const triggers = await rows(`SELECT c.relname AS table_name,t.tgname AS name,pg_get_triggerdef(t.oid,true) AS definition,
    p.proname AS function_name,p.prosecdef AS security_definer
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname='app' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`);
  const functions = await rows(`SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,
    p.prosecdef AS security_definer,p.proconfig AS settings FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' ORDER BY p.proname`);
  const migrations = await rows('SELECT name FROM migrations.kysely_migration ORDER BY name');
  const source = ts.createSourceFile('schema.ts', await readFile(resolve(root,'apps/api/src/database/schema.ts'),'utf8'),ts.ScriptTarget.Latest,true);
  const mapping = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text==='Database');
  const mapped = mapping.members.map(member => member.name.getText(source).replaceAll("'",''));
  const pending = (await readdir(resolve(root,'apps/api/migrations'))).filter(name=>name.endsWith('.sql')).map(name=>name.slice(0,-4)).filter(name=>!migrations.some(m=>m.name===name));
  const foreignKeys = constraints.filter(c=>c.kind==='f');
  const reviewCandidates = foreignKeys.filter(fk=>!indexes.some(index=>index.table_name===fk.table_name && index.valid && index.method==='btree' && !index.predicate && fk.columns.every((col,i)=>index.columns[i]===col)));
  schema = {
    capturedAt: new Date().toISOString(), scope: 'Catalog metadata only; no application row data or credentials.',
    summary: { tables:tables.length,columns:columns.length,foreignKeys:foreignKeys.length,indexes:indexes.length,triggers:triggers.length,functions:functions.length,migrations:migrations.length,latestMigration:migrations.at(-1)?.name,mappedTables:mapped.length },
    mappingReview: { unmappedTables:tables.filter(t=>!mapped.includes(t.name)).map(t=>t.name),missingTables:mapped.filter(name=>!tables.some(t=>t.name===name)),pendingMigrations:pending },
    invalidIndexes:indexes.filter(i=>!i.valid),unvalidatedConstraints:constraints.filter(c=>!c.validated),
    foreignKeyIndexReview:reviewCandidates,
    tables:tables.map(table=>({...table,domain:domain(table.name),columns:columns.filter(c=>c.table_name===table.name),constraints:constraints.filter(c=>c.table_name===table.name),indexes:indexes.filter(c=>c.table_name===table.name),triggers:triggers.filter(c=>c.table_name===table.name)})),
    functions,migrations:migrations.map(m=>m.name),
  };
  await client.query('COMMIT');
} finally { await client.end(); }
await writeFile(resolve(root,'docs/database-schema.json'),JSON.stringify(schema,null,2));
await writeFile(resolve(root,'docs/database-design.html'), databaseExplorer(schema));
const counts=Object.entries(Object.groupBy(schema.tables,t=>t.domain)).map(([name,items])=>({domain:name,tables:items.length}));
console.log(JSON.stringify({...schema.summary,domains:counts,mappingReview:schema.mappingReview,invalidIndexes:schema.invalidIndexes.length,unvalidatedConstraints:schema.unvalidatedConstraints.map(c=>`${c.table_name}.${c.name}`),foreignKeyIndexCandidates:schema.foreignKeyIndexReview.length},null,2));
