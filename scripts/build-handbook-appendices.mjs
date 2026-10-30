import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const schemaPath = path.join(root, 'apps/api/src/database/schema.ts');
const schema = ts.createSourceFile(schemaPath, fs.readFileSync(schemaPath, 'utf8'), ts.ScriptTarget.Latest, true);
const interfaces = new Map(schema.statements.filter(ts.isInterfaceDeclaration).map(n => [n.name.text, n]));
const mapped = interfaces.get('Database').members;
const migrationDir = path.join(root, 'apps/api/migrations');
const migrations = fs.readdirSync(migrationDir).filter(n => n.endsWith('.sql')).sort();
const origins = new Map();

// Read table declarations, respecting quoted strings and comments while balancing parentheses.
for (const file of migrations) {
  const sql = fs.readFileSync(path.join(migrationDir, file), 'utf8');
  for (const match of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?app\.(\w+)\s*\(/gi)) {
    const start = match.index + match[0].length;
    let depth = 1, quote = null, comment = null, i = start;
    for (; i < sql.length && depth; i++) {
      const c = sql[i], n = sql[i + 1];
      if (comment === 'line') { if (c === '\n') comment = null; continue; }
      if (comment === 'block') { if (c === '*' && n === '/') { comment = null; i++; } continue; }
      if (quote) { if (c === quote) { if (n === quote) i++; else quote = null; } continue; }
      if (c === '-' && n === '-') { comment = 'line'; i++; continue; }
      if (c === '/' && n === '*') { comment = 'block'; i++; continue; }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === '(') depth++;
      if (c === ')') depth--;
    }
    const declaration = sql.slice(start, i - 1);
    const references = [...new Set([...declaration.matchAll(/REFERENCES\s+app\.(\w+)/gi)].map(m => m[1]))];
    origins.set(match[1], { file, references });
  }
}

let appendix = '\n## Appendix A. Complete mapped database table reference\n\n';
appendix += `Generated from the current TypeScript AST: **${mapped.length} mapped tables**, with columns taken from each corresponding interface. This is a source inventory, not a schema dump from a running PostgreSQL instance. Creation-time foreign-key targets come from SQL CREATE TABLE declarations; later ALTER constraints, triggers, function rules, indexes and grants must be read in migration history. A relation not listed here may still exist. Column lists describe the current mapped interface, not only the creation migration.\n\n`;
appendix += 'Read `DatabaseSet` as selected from the database but not directly writable, `InsertOnly` as immutable after insert, `Writable` as application-writable, and `ColumnType` as explicit select/insert/update types. The exact wrapper and nullability are available in the linked schema interface. History/event tables often hold evidence; do not infer editability from the word table.\n\n';

function group(name) {
  if (name.startsWith('ai_')) return 'AI drafting';
  if (name.startsWith('hr_')) return 'People and HR';
  if (name.startsWith('aml_')) return 'AML and compliance';
  if (/^(onboarding_|engagement_|contact_verification|client_onboarding|firm_policy|policy_|matter_fee_estimate|conflict_alias|conflict_connected|conflict_decision)/.test(name)) return 'Onboarding, policies and engagement';
  if (/^(finance_|bank_|bill_|issued_bill|credit_|client_payment|payment_|staff_rate|time_|statement_|reconciliation|receipt|allocation)/.test(name)) return 'Finance and money';
  if (/^(client|matter|conflict|portal)/.test(name)) return 'Clients, matters, conflicts and portal';
  if (/^(document)/.test(name)) return 'Documents';
  if (/^(task|notification|email)/.test(name)) return 'Tasks, notifications and email';
  return 'Identity, audit and shared records';
}
const grouped = new Map();
let totalColumns = 0;
for (const entry of mapped) {
  const name = entry.name.getText(schema).replaceAll("'", '');
  const type = interfaces.get(entry.type.getText(schema));
  if (!type) throw new Error(`No table interface for ${name}`);
  const fields = type.members.filter(ts.isPropertySignature);
  totalColumns += fields.length;
  const origin = origins.get(name);
  let block = `### ${name}\n\n`;
  block += `**Mapped columns (${fields.length}):** ${fields.map(f => '`' + f.name.getText(schema) + '`').join(', ')}.\n\n`;
  const representative = fields.filter(f => /^(id|.*_id|status|.*_pence|.*_on|created_at|occurred_at)$/.test(f.name.getText(schema))).slice(0, 4);
  block += `**Type examples:** ${representative.map(f => '`' + f.name.getText(schema) + ': ' + f.type.getText(schema).replace(/\s+/g, ' ') + '`').join('; ')}.\n\n`;
  if (origin) {
    block += `**Created in:** [${origin.file}](../apps/api/migrations/${origin.file}). `;
    block += `**Creation-declared FK targets:** ${origin.references.length ? origin.references.map(n => '`' + n + '`').join(', ') : 'none extracted'}.\n\n`;
  } else block += '**Origin:** inspect migration history; no CREATE TABLE origin was extracted.\n\n';
  const category = group(name);
  if (!grouped.has(category)) grouped.set(category, []);
  grouped.get(category).push({ name, block });
}
for (const [category, entries] of grouped) {
  appendix += `## Database group: ${category}\n\n`;
  appendix += entries.sort((a,b) => a.name.localeCompare(b.name)).map(e => e.block).join('');
}
appendix += `## Appendix B. All ${migrations.length} SQL migrations\n\n`;
appendix += 'Apply these in order through the migration runner, not by copying isolated statements into a production console. Later migrations may strengthen or alter earlier behavior. Names are a navigation aid, not a complete description of enforcement.\n\n';
appendix += '| Migration | Study area |\n|---|---|\n';
for (const file of migrations) appendix += `| [${file}](../apps/api/migrations/${file}) | ${file.replace(/^\d+_/, '').replace(/\.sql$/, '').replaceAll('_', ' ')} |\n`;

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(directory,e.name)) : [path.join(directory,e.name)]);
}
const decoratorCall = (node, name) => (ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [])
  .map(d => d.expression).find(e => ts.isCallExpression(e) && e.expression.getText() === name);
const argument = (call) => call?.arguments[0] && ts.isStringLiteralLike(call.arguments[0]) ? call.arguments[0].text : '';
appendix += '\n## Appendix C. Source-extracted API route index\n\n';
appendix += 'Routes are extracted from controller/method decorators. Permissions here include only the explicit `RequirePermission` decorator; audience guards, class decorators, record rules, protected SQL and any additional runtime checks still apply. A dash does not mean public access. This index does not claim every endpoint was exercised.\n\n';
let routes = 0;
for (const file of walk(path.join(root,'apps/api/src')).filter(n => n.endsWith('.controller.ts')).sort()) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file,'utf8'), ts.ScriptTarget.Latest, true);
  for (const cls of sf.statements.filter(ts.isClassDeclaration)) {
    const controller = decoratorCall(cls,'Controller');
    if (!controller) continue;
    const prefix = argument(controller);
    const rows = [];
    for (const method of cls.members.filter(ts.isMethodDeclaration)) {
      for (const verb of ['Get','Post','Put','Patch','Delete','Head','Options']) {
        const route = decoratorCall(method,verb);
        if (!route) continue;
        const url = '/' + [prefix, argument(route)].filter(Boolean).join('/');
        const permissions = decoratorCall(method,'RequirePermission') ?? decoratorCall(cls,'RequirePermission');
        const permissionText = permissions ? permissions.arguments.map(a => a.getText(sf).replaceAll("'", '')).join(', ') : '—';
        rows.push(`| ${verb.toUpperCase()} | \`${url}\` | ${permissionText} |`);
        routes++;
      }
    }
    if (rows.length) {
      const relative = path.relative(root,file).replaceAll('\\','/');
      appendix += `### ${cls.name?.text ?? path.basename(file)}\n\n[Controller source](../${relative}).\n\n| Method | Path | Declared permission |\n|---|---|---|\n${rows.join('\n')}\n\n`;
    }
  }
}
appendix += `## Appendix extraction totals\n\n${mapped.length} mapped tables; ${totalColumns} mapped columns; ${migrations.length} migrations; ${routes} controller routes. These are source inventories, not coverage counts.\n`;
const target = path.join(root,'docs/whole-system-design-handbook.md');
const existing = fs.readFileSync(target,'utf8');
fs.writeFileSync(target, existing.split('<!-- DATABASE_APPENDICES -->')[0] + '<!-- DATABASE_APPENDICES -->\n' + appendix);
console.log(JSON.stringify({ tables: mapped.length, columns: totalColumns, migrations: migrations.length, routes }));
