import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTemplate,validateCapacity} from '../infra/aws/app-stack.mjs';
test('capacity checks account for rolling-deployment surge and supported task sizes',()=>{
 assert.deepEqual(validateCapacity(),{replicaPoolConnections:40,totalBudgetRequired:60});
 assert.throws(()=>validateCapacity({maxReplicas:8,poolMax:10,budget:100}),/surge/);
 assert.throws(()=>validateCapacity({cpu:'4096',memory:'4096'}),/CPU\/memory/);
 assert.throws(()=>validateCapacity({poolMax:0}));
});
test('deployment separates operator credentials, private workloads and readiness routing',()=>{
 const t=buildTemplate(),r=t.Resources;
 assert.equal(t.Parameters.EnableService.Default,'false');
 assert.equal(r.AppService.Condition,'DeployApplication');
 assert.equal(r.AppService.Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp,'DISABLED');
 assert.equal(r.TargetGroup.Properties.HealthCheckPath,'/api/ready');
 assert.equal(r.AppService.Properties.DeploymentConfiguration.MinimumHealthyPercent,100);
 const api=r.AppTask.Properties.ContainerDefinitions.find(c=>c.Name==='api');
 assert.ok(api.Secrets.every(s=>JSON.stringify(s.ValueFrom).includes('RuntimeSecretArn')));
 assert.ok(!JSON.stringify(r.AppTask).includes('MigrationSecretArn'));
 assert.ok(JSON.stringify(r.MigrationTask).includes('MigrationSecretArn'));
 assert.ok(!JSON.stringify(r.MigrationTask).includes('RuntimeSecretArn'));
 assert.equal(api.Environment.find(e=>e.Name==='TRUSTED_PROXIES').Value,'loopback');
 assert.equal(r.GatewayIngress.Properties.FromPort,10000);
 assert.equal(r.DatabaseIngress.Properties.SourceSecurityGroupId.Ref,'TaskSecurityGroup');
 assert.equal(r.CpuScaling.Properties.TargetTrackingScalingPolicyConfiguration.ScaleInCooldown,300);
});
