import {readFileSync} from 'node:fs';
import pg from 'pg';
import {buildTemplate,validateCapacity} from '../../infra/aws/app-stack.mjs';
try{
 const entries=JSON.parse(readFileSync(process.argv[2]??'','utf8'));
 if(!Array.isArray(entries))throw new Error('Provide a CloudFormation parameter array');
 const template=buildTemplate(),values={};
 for(const [key,definition]of Object.entries(template.Parameters))if(definition.Default!==undefined)values[key]=String(definition.Default);
 for(const entry of entries){if(!Object.hasOwn(template.Parameters,entry.ParameterKey)||typeof entry.ParameterValue!=='string')throw new Error('Unknown or invalid parameter');values[entry.ParameterKey]=entry.ParameterValue;}
 for(const [key,definition]of Object.entries(template.Parameters)){
  const value=values[key];if(value===undefined)throw new Error('Missing '+key);
  if(definition.AllowedPattern&&!new RegExp(definition.AllowedPattern).test(value))throw new Error('Invalid '+key);
  if(definition.AllowedValues&&!definition.AllowedValues.map(String).includes(value))throw new Error('Invalid '+key);
 }
 const capacity=validateCapacity({maxReplicas:Number(values.MaxReplicas),poolMax:Number(values.PoolMax),budget:Number(values.DatabaseConnectionBudget),cpu:values.TaskCpu,memory:values.TaskMemory});
 if(values.PublicSubnetA===values.PublicSubnetB||values.PrivateSubnetA===values.PrivateSubnetB)throw new Error('Choose distinct subnets in separate availability zones');
 if(values.RuntimeSecretArn===values.MigrationSecretArn)throw new Error('Runtime and migration credentials must be separate secrets');
 if(process.argv.includes('--check-database')){
  const url=new URL(process.env.SCALING_DATABASE_URL??'');
  if(url.searchParams.get('sslmode')!=='verify-full')throw new Error('Database preflight requires verify-full TLS');
  const db=new pg.Client({connectionString:url.href,connectionTimeoutMillis:5000,statement_timeout:5000});
  try{
   await db.connect();
   const {rows:[role]}=await db.query("SELECT current_user AS role,rolsuper,rolbypassrls,rolconnlimit,current_setting('max_connections')::int AS maximum,current_setting('server_version_num')::int AS version FROM pg_roles WHERE rolname=current_user");
   if(role.role!=='pms_app'||role.rolsuper||role.rolbypassrls||role.version<180000)throw new Error('Use a restricted pms_app role on PostgreSQL 18 or later');
   if(Number(values.DatabaseConnectionBudget)>role.maximum||(role.rolconnlimit>=0&&capacity.replicaPoolConnections>role.rolconnlimit))throw new Error('Configured replica capacity exceeds the database or role limit');
  }finally{await db.end();}
 }
 console.log(JSON.stringify({valid:true,...capacity,databaseChecked:process.argv.includes('--check-database'),resourcesCreated:false}));
}catch(error){console.error(error instanceof Error&&/^(Missing|Invalid|Unknown|Choose|Runtime|Configured|Use |Database preflight|Connection budget|Unsupported|Provide)/.test(error.message)?error.message:'AWS scaling preflight failed; inspect private configuration without logging credentials.');process.exitCode=1;}
