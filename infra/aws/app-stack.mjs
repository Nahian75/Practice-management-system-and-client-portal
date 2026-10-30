// Generates a reviewable CloudFormation template. Does not call AWS or deploy.
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const ref=name=>({Ref:name}),get=(name,key)=>({'Fn::GetAtt':[name,key]}),sub=value=>({'Fn::Sub':value});
const resource=(Type,Properties,extra={})=>({Type,Properties,...extra});
const param=(Type,more={})=>({Type,...more});
const env=values=>Object.entries(values).map(([Name,Value])=>({Name,Value}));
const jsonSecret=(secret,key)=>({'Fn::Join':['',[ref(secret),':'+key+'::']]});
const log=name=>({LogDriver:'awslogs',Options:{'awslogs-group':ref('ApplicationLogs'),'awslogs-region':ref('AWS::Region'),'awslogs-stream-prefix':name}});
const health=url=>({Command:['CMD-SHELL',`node -e "fetch('${url}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`],Interval:15,Timeout:10,Retries:10,StartPeriod:300});
const trust={Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'ecs-tasks.amazonaws.com'},Action:'sts:AssumeRole',Condition:{StringEquals:{'aws:SourceAccount':ref('AWS::AccountId')},ArnLike:{'aws:SourceArn':sub('arn:${AWS::Partition}:ecs:${AWS::Region}:${AWS::AccountId}:*')}}}]};
const secretRole=secret=>resource('AWS::IAM::Role',{AssumeRolePolicyDocument:trust,
 ManagedPolicyArns:[sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy')],
 Policies:[{PolicyName:'ReadOnlyAssignedSecret',PolicyDocument:{Version:'2012-10-17',Statement:[
  {Effect:'Allow',Action:['secretsmanager:GetSecretValue'],Resource:ref(secret)},
  {'Fn::If':['HasSecretsKmsKey',{Effect:'Allow',Action:['kms:Decrypt'],Resource:ref('SecretsKmsKeyArn'),Condition:{StringEquals:{'kms:ViaService':sub('secretsmanager.${AWS::Region}.amazonaws.com')}}},ref('AWS::NoValue')]},
 ]}}]});
const imagePattern='^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com(\\.cn)?/[a-zA-Z0-9./_-]+@sha256:[a-f0-9]{64}$';
export function buildTemplate(){
 const t={AWSTemplateFormatVersion:'2010-09-09',Description:'Stass isolated-firm app scaling on ECS Fargate. Existing private RDS 18, S3, SMTP, VPC/NAT and secrets are prerequisites. Service starts disabled until a one-off migration succeeds.',
 Parameters:{
  VpcId:param('AWS::EC2::VPC::Id'),PublicSubnetA:param('AWS::EC2::Subnet::Id'),PublicSubnetB:param('AWS::EC2::Subnet::Id'),
  PrivateSubnetA:param('AWS::EC2::Subnet::Id'),PrivateSubnetB:param('AWS::EC2::Subnet::Id'),
  DatabaseSecurityGroupId:param('AWS::EC2::SecurityGroup::Id'),
  DomainName:param('String',{AllowedPattern:'^[a-zA-Z0-9][a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$'}),
  CertificateArn:param('String',{AllowedPattern:'^arn:[^:]+:acm:[^:]+:[0-9]{12}:certificate/.+$'}),
  ApiImage:param('String',{AllowedPattern:imagePattern}),GatewayImage:param('String',{AllowedPattern:imagePattern}),
  RuntimeSecretArn:param('String',{AllowedPattern:'^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:.+$'}),
  MigrationSecretArn:param('String',{AllowedPattern:'^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:.+$'}),
  SecretsKmsKeyArn:param('String',{Default:'',AllowedPattern:'^$|^arn:[^:]+:kms:[^:]+:[0-9]{12}:key/.+$'}),
  EnableService:param('String',{Default:'false',AllowedValues:['false','true']}),
  MaxReplicas:param('Number',{Default:4,AllowedValues:[2,4,6,8]}),
  PoolMax:param('Number',{Default:5,MinValue:2,MaxValue:20}),DatabaseConnectionBudget:param('Number',{Default:100,MinValue:30,MaxValue:10000}),
  TaskCpu:param('String',{Default:'1024',AllowedValues:['512','1024','2048','4096']}),
  TaskMemory:param('String',{Default:'4096',AllowedValues:['4096','8192','16384']}),
  AlarmTopicArn:param('String',{AllowedPattern:'^arn:[^:]+:sns:[^:]+:[0-9]{12}:.+$'}),
 },
 Mappings:{ReplicaLimits:{'2':{Surge:'4'},'4':{Surge:'8'},'6':{Surge:'12'},'8':{Surge:'16'}}},
 Conditions:{DeployApplication:{'Fn::Equals':[ref('EnableService'),'true']},HasSecretsKmsKey:{'Fn::Not':[{'Fn::Equals':[ref('SecretsKmsKeyArn'),'']}] }},
 Rules:{DistinctSubnets:{Assertions:[{Assert:{'Fn::Not':[{'Fn::Equals':[ref('PublicSubnetA'),ref('PublicSubnetB')]}]},AssertDescription:'Public subnets must be distinct and in different AZs.'},{Assert:{'Fn::Not':[{'Fn::Equals':[ref('PrivateSubnetA'),ref('PrivateSubnetB')]}]},AssertDescription:'Private subnets must be distinct and in different AZs.'}]},
 ValidTaskSize:{Assertions:[{Assert:{'Fn::Or':[
  {'Fn::And':[{'Fn::Equals':[ref('TaskCpu'),'512']},{'Fn::Equals':[ref('TaskMemory'),'4096']}]},
  {'Fn::And':[{'Fn::Equals':[ref('TaskCpu'),'1024']},{'Fn::Or':[{'Fn::Equals':[ref('TaskMemory'),'4096']},{'Fn::Equals':[ref('TaskMemory'),'8192']}]}]},
  {'Fn::Equals':[ref('TaskCpu'),'2048']},
  {'Fn::And':[{'Fn::Equals':[ref('TaskCpu'),'4096']},{'Fn::Not':[{'Fn::Equals':[ref('TaskMemory'),'4096']}]}]},
 ]},AssertDescription:'Choose a supported Fargate CPU/memory pair.'}]}},Resources:{},Outputs:{}};
 const r=t.Resources;
 r.Cluster=resource('AWS::ECS::Cluster',{ClusterSettings:[{Name:'containerInsights',Value:'enabled'}]});
 r.ApplicationLogs=resource('AWS::Logs::LogGroup',{RetentionInDays:30},{DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain'});
 r.LoadBalancerSecurityGroup=resource('AWS::EC2::SecurityGroup',{GroupDescription:'Public HTTPS gateway only',VpcId:ref('VpcId'),
  SecurityGroupIngress:[80,443].map(port=>({IpProtocol:'tcp',FromPort:port,ToPort:port,CidrIp:'0.0.0.0/0'})),
  SecurityGroupEgress:[{IpProtocol:'tcp',FromPort:10000,ToPort:10000,DestinationSecurityGroupId:ref('TaskSecurityGroup')}]});
 r.TaskSecurityGroup=resource('AWS::EC2::SecurityGroup',{GroupDescription:'Private tasks; only ALB may reach gateway',VpcId:ref('VpcId'),
  SecurityGroupEgress:[...[80,443,465,587].map(port=>({IpProtocol:'tcp',FromPort:port,ToPort:port,CidrIp:'0.0.0.0/0'})),
   {IpProtocol:'tcp',FromPort:5432,ToPort:5432,DestinationSecurityGroupId:ref('DatabaseSecurityGroupId')}]});
 r.GatewayIngress=resource('AWS::EC2::SecurityGroupIngress',{GroupId:ref('TaskSecurityGroup'),SourceSecurityGroupId:ref('LoadBalancerSecurityGroup'),IpProtocol:'tcp',FromPort:10000,ToPort:10000});
 r.DatabaseIngress=resource('AWS::EC2::SecurityGroupIngress',{GroupId:ref('DatabaseSecurityGroupId'),SourceSecurityGroupId:ref('TaskSecurityGroup'),IpProtocol:'tcp',FromPort:5432,ToPort:5432});
 r.LoadBalancer=resource('AWS::ElasticLoadBalancingV2::LoadBalancer',{Type:'application',Scheme:'internet-facing',Subnets:[ref('PublicSubnetA'),ref('PublicSubnetB')],SecurityGroups:[ref('LoadBalancerSecurityGroup')],
  LoadBalancerAttributes:[{Key:'routing.http.drop_invalid_header_fields.enabled',Value:'true'},{Key:'routing.http.desync_mitigation_mode',Value:'strictest'},{Key:'routing.http.xff_header_processing.mode',Value:'append'},{Key:'idle_timeout.timeout_seconds',Value:'120'}]});
 r.TargetGroup=resource('AWS::ElasticLoadBalancingV2::TargetGroup',{VpcId:ref('VpcId'),Protocol:'HTTP',Port:10000,TargetType:'ip',HealthCheckPath:'/api/ready',HealthCheckIntervalSeconds:15,HealthCheckTimeoutSeconds:10,
  HealthyThresholdCount:2,UnhealthyThresholdCount:2,Matcher:{HttpCode:'200'},TargetGroupAttributes:[{Key:'deregistration_delay.timeout_seconds',Value:'90'},{Key:'stickiness.enabled',Value:'false'}]});
 r.HttpsListener=resource('AWS::ElasticLoadBalancingV2::Listener',{LoadBalancerArn:ref('LoadBalancer'),Port:443,Protocol:'HTTPS',SslPolicy:'ELBSecurityPolicy-TLS13-1-3-2021-06',Certificates:[{CertificateArn:ref('CertificateArn')}],DefaultActions:[{Type:'forward',TargetGroupArn:ref('TargetGroup')}]});
 r.HttpRedirect=resource('AWS::ElasticLoadBalancingV2::Listener',{LoadBalancerArn:ref('LoadBalancer'),Port:80,Protocol:'HTTP',DefaultActions:[{Type:'redirect',RedirectConfig:{Protocol:'HTTPS',Port:'443',StatusCode:'HTTP_301'}}]});
 r.RuntimeExecutionRole=secretRole('RuntimeSecretArn');r.MigrationExecutionRole=secretRole('MigrationSecretArn');
 r.TaskRole=resource('AWS::IAM::Role',{AssumeRolePolicyDocument:trust});
 const secretNames=['DATABASE_URL','TOTP_ENCRYPTION_KEY','MAIL_ENCRYPTION_KEY','FINANCE_ENCRYPTION_KEY','AML_ENCRYPTION_KEY','SUSPICION_ENCRYPTION_KEY','HR_ENCRYPTION_KEY','DOCUMENT_ENCRYPTION_KEY','ENCRYPTION_KEY_VERSION','PREVIOUS_ENCRYPTION_KEYS','SMTP_URL','MAIL_FROM_ADDRESS','DOCUMENTS_S3_ENDPOINT','DOCUMENTS_S3_REGION','DOCUMENTS_S3_BUCKET','DOCUMENTS_S3_ACCESS_KEY','DOCUMENTS_S3_SECRET_KEY'];
 const containers=[
  {Name:'scanner',Image:'clamav/clamav:1.5.4@sha256:ebec5bc138401b36ae987caa1a3fa3c3b2a21ed3d51f0bfa5852825e663e67b0',Essential:true,Environment:env({TZ:'UTC',CLAMD_CONF_AlertExceedsMax:'yes'}),
   HealthCheck:{Command:['CMD-SHELL','clamdcheck.sh'],Interval:30,Timeout:10,Retries:5,StartPeriod:300},StopTimeout:120,LogConfiguration:log('scanner')},
  {Name:'api',Image:ref('ApiImage'),Essential:true,DependsOn:[{ContainerName:'scanner',Condition:'START'}],ReadonlyRootFilesystem:true,StopTimeout:120,
   Environment:env({NODE_ENV:'production',HOST:'127.0.0.1',PORT:'3001',APP_BASE_URL:sub('https://${DomainName}'),TRUSTED_PROXIES:'loopback',
    NODE_EXTRA_CA_CERTS:'/app/infra/aws/rds-ca.crt',CLAMAV_HOST:'127.0.0.1',CLAMAV_PORT:'3310',
    DATABASE_POOL_MAX:ref('PoolMax'),DATABASE_REPLICA_LIMIT:{'Fn::FindInMap':['ReplicaLimits',ref('MaxReplicas'),'Surge']},DATABASE_CONNECTION_BUDGET:ref('DatabaseConnectionBudget'),DATABASE_RESERVED_CONNECTIONS:'20',
    SANCTIONS_LIST_URL:'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv'}),
   Secrets:secretNames.map(Name=>({Name,ValueFrom:jsonSecret('RuntimeSecretArn',Name)})),HealthCheck:health('http://127.0.0.1:3001/ready'),LogConfiguration:log('api')},
  {Name:'gateway',Image:ref('GatewayImage'),Essential:true,DependsOn:[{ContainerName:'api',Condition:'START'}],StopTimeout:120,
   PortMappings:[{ContainerPort:10000,Protocol:'tcp'}],Environment:env({PORT:'10000',API_HOST:'127.0.0.1',APP_NAME:'Stass'}),HealthCheck:health('http://127.0.0.1:10000/api/ready'),LogConfiguration:log('gateway')},
 ];
 const task=(executionRole,defs)=>resource('AWS::ECS::TaskDefinition',{RequiresCompatibilities:['FARGATE'],NetworkMode:'awsvpc',Cpu:ref('TaskCpu'),Memory:ref('TaskMemory'),RuntimePlatform:{CpuArchitecture:'X86_64',OperatingSystemFamily:'LINUX'},ExecutionRoleArn:get(executionRole,'Arn'),TaskRoleArn:get('TaskRole','Arn'),ContainerDefinitions:defs});
 r.AppTask=task('RuntimeExecutionRole',containers);
 const operations={...containers[1],Name:'operations',Command:['node','-e',"console.error('Provide a reviewed operations command override');process.exit(1)"]};
 delete operations.DependsOn;delete operations.HealthCheck;
 r.OperationsTask=task('RuntimeExecutionRole',[operations]);
 r.MigrationTask=task('MigrationExecutionRole',[{Name:'migration',Image:ref('ApiImage'),Essential:true,ReadonlyRootFilesystem:true,StopTimeout:120,Command:['node','dist/database/migrate.js'],
  Environment:env({NODE_ENV:'production',NODE_EXTRA_CA_CERTS:'/app/infra/aws/rds-ca.crt'}),Secrets:[{Name:'MIGRATION_DATABASE_URL',ValueFrom:jsonSecret('MigrationSecretArn','MIGRATION_DATABASE_URL')}],LogConfiguration:log('migration')}]);
 r.AppService=resource('AWS::ECS::Service',{Cluster:ref('Cluster'),TaskDefinition:ref('AppTask'),LaunchType:'FARGATE',PlatformVersion:'1.4.0',DesiredCount:2,EnableExecuteCommand:false,
  DeploymentConfiguration:{MinimumHealthyPercent:100,MaximumPercent:200,DeploymentCircuitBreaker:{Enable:true,Rollback:true}},
  AvailabilityZoneRebalancing:'ENABLED',HealthCheckGracePeriodSeconds:600,LoadBalancers:[{ContainerName:'gateway',ContainerPort:10000,TargetGroupArn:ref('TargetGroup')}],
  NetworkConfiguration:{AwsvpcConfiguration:{AssignPublicIp:'DISABLED',SecurityGroups:[ref('TaskSecurityGroup')],Subnets:[ref('PrivateSubnetA'),ref('PrivateSubnetB')]}}},
  {Condition:'DeployApplication',DependsOn:['HttpsListener','GatewayIngress','DatabaseIngress']});
 r.ScalingTarget=resource('AWS::ApplicationAutoScaling::ScalableTarget',{ServiceNamespace:'ecs',ScalableDimension:'ecs:service:DesiredCount',MinCapacity:2,MaxCapacity:ref('MaxReplicas'),
  ResourceId:{'Fn::Join':['',['service/',ref('Cluster'),'/',get('AppService','Name')]]},
  RoleARN:sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/aws-service-role/ecs.application-autoscaling.amazonaws.com/AWSServiceRoleForApplicationAutoScaling_ECSService')},{Condition:'DeployApplication'});
 for(const [name,type,target]of [['CpuScaling','ECSServiceAverageCPUUtilization',55],['MemoryScaling','ECSServiceAverageMemoryUtilization',70]])r[name]=resource('AWS::ApplicationAutoScaling::ScalingPolicy',{
  PolicyName:sub('${AWS::StackName}-'+name),PolicyType:'TargetTrackingScaling',ScalingTargetId:ref('ScalingTarget'),TargetTrackingScalingPolicyConfiguration:{TargetValue:target,ScaleOutCooldown:60,ScaleInCooldown:300,PredefinedMetricSpecification:{PredefinedMetricType:type}}},{Condition:'DeployApplication'});
 r.Firewall=resource('AWS::WAFv2::WebACL',{Scope:'REGIONAL',DefaultAction:{Allow:{}},VisibilityConfig:{CloudWatchMetricsEnabled:true,MetricName:'ApplicationFirewall',SampledRequestsEnabled:false},Rules:[
  {Name:'IpReputation',Priority:0,OverrideAction:{None:{}},Statement:{ManagedRuleGroupStatement:{VendorName:'AWS',Name:'AWSManagedRulesAmazonIpReputationList'}},VisibilityConfig:{CloudWatchMetricsEnabled:true,MetricName:'IpReputation',SampledRequestsEnabled:false}},
  {Name:'NetworkCeiling',Priority:1,Action:{Block:{}},Statement:{RateBasedStatement:{AggregateKeyType:'IP',Limit:60000,EvaluationWindowSec:300}},VisibilityConfig:{CloudWatchMetricsEnabled:true,MetricName:'NetworkCeiling',SampledRequestsEnabled:false}},
 ]});
 r.FirewallAssociation=resource('AWS::WAFv2::WebACLAssociation',{ResourceArn:ref('LoadBalancer'),WebACLArn:get('Firewall','Arn')});
 const alarm=(name,namespace,metric,dimensions,threshold,comparison)=>resource('AWS::CloudWatch::Alarm',{AlarmDescription:name,Namespace:namespace,MetricName:metric,Dimensions:dimensions,
  Statistic:'Sum',Period:60,EvaluationPeriods:2,Threshold:threshold,ComparisonOperator:comparison,TreatMissingData:'notBreaching',AlarmActions:[ref('AlarmTopicArn')],OKActions:[ref('AlarmTopicArn')]});
 r.ServerErrors=alarm('Investigate application 5xx','AWS/ApplicationELB','HTTPCode_Target_5XX_Count',[{Name:'LoadBalancer',Value:get('LoadBalancer','LoadBalancerFullName')}],5,'GreaterThanOrEqualToThreshold');
 r.NoHealthyTargets=resource('AWS::CloudWatch::Alarm',{AlarmDescription:'No ready application targets',Namespace:'AWS/ApplicationELB',MetricName:'HealthyHostCount',Dimensions:[{Name:'LoadBalancer',Value:get('LoadBalancer','LoadBalancerFullName')},{Name:'TargetGroup',Value:get('TargetGroup','TargetGroupFullName')}],
  Statistic:'Minimum',Period:60,EvaluationPeriods:2,Threshold:1,ComparisonOperator:'LessThanThreshold',TreatMissingData:'breaching',AlarmActions:[ref('AlarmTopicArn')],OKActions:[ref('AlarmTopicArn')]},{Condition:'DeployApplication'});
 t.Outputs={Cluster:{Value:ref('Cluster')},MigrationTask:{Value:ref('MigrationTask')},OperationsTask:{Value:ref('OperationsTask')},AppTask:{Value:ref('AppTask')},TaskSecurityGroup:{Value:ref('TaskSecurityGroup')},LoadBalancerDns:{Value:get('LoadBalancer','DNSName')},Url:{Value:sub('https://${DomainName}')}};
 return t;
}
export function validateCapacity({maxReplicas=4,poolMax=5,budget=100,reserved=20,cpu='1024',memory='4096'}={}){
 if(![2,4,6,8].includes(maxReplicas)||!Number.isInteger(poolMax)||poolMax<2||poolMax>20||!Number.isInteger(budget)||budget<30||budget>10000||reserved!==20)throw new Error('Invalid scaling capacity settings');
 if(2*maxReplicas*poolMax+reserved>budget)throw new Error('Connection budget must include rolling-deployment surge');
 const sizes={'512':['4096'],'1024':['4096','8192'],'2048':['4096','8192','16384'],'4096':['8192','16384']};
 if(!sizes[cpu]?.includes(memory))throw new Error('Unsupported task CPU/memory pair');
 return {replicaPoolConnections:2*maxReplicas*poolMax,totalBudgetRequired:2*maxReplicas*poolMax+reserved};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 validateCapacity();const template=buildTemplate();
 writeFileSync(new URL('./app-scaling.json',import.meta.url),JSON.stringify(template,null,2)+'\n');
 const example={VpcId:'vpc-00000000000000000',PublicSubnetA:'subnet-00000000000000001',PublicSubnetB:'subnet-00000000000000002',PrivateSubnetA:'subnet-00000000000000003',PrivateSubnetB:'subnet-00000000000000004',
  DatabaseSecurityGroupId:'sg-00000000000000000',DomainName:'demo.example.test',CertificateArn:'arn:aws:acm:eu-west-2:000000000000:certificate/REPLACE',
  ApiImage:'000000000000.dkr.ecr.eu-west-2.amazonaws.com/stass-api@sha256:'+'0'.repeat(64),GatewayImage:'000000000000.dkr.ecr.eu-west-2.amazonaws.com/stass-gateway@sha256:'+'0'.repeat(64),
  RuntimeSecretArn:'arn:aws:secretsmanager:eu-west-2:000000000000:secret:runtime-REPLACE',MigrationSecretArn:'arn:aws:secretsmanager:eu-west-2:000000000000:secret:migration-REPLACE',AlarmTopicArn:'arn:aws:sns:eu-west-2:000000000000:REPLACE'};
 const parameters=Object.entries(template.Parameters).map(([ParameterKey,definition])=>({ParameterKey,ParameterValue:String(example[ParameterKey]??definition.Default)}));
 writeFileSync(new URL('./parameters.example.json',import.meta.url),JSON.stringify(parameters,null,2)+'\n');
 console.log('Generated AWS scaling template and placeholder parameters; no resources created.');
}
