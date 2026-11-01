export interface WorkspacePageShortcut {href:string;label:string;detail:string}
export interface WorkspacePageAccess {canViewFinance?:boolean;canViewCompliance?:boolean;canViewHr?:boolean}
export function workspacePages(canViewStaff:boolean,canViewWork:boolean,access:WorkspacePageAccess={}):WorkspacePageShortcut[]{
 return [
  {href:'/',label:'Dashboard',detail:'Practice overview'},
  ...(canViewStaff?[{href:'/staff',label:'Staff management',detail:'Users, invitations, roles and account access'}]:[]),
  ...(canViewWork?[
   {href:'/matters',label:'Matters',detail:'Matter workspace'},
   {href:'/clients',label:'Contacts',detail:'Clients and contacts'},
   {href:'/tasks',label:'Tasks',detail:'Assigned work'},
   {href:'/documents',label:'Documents',detail:'Document library'},
   {href:'/activities',label:'Activities',detail:'Time entries and recorded work'},
   {href:'/settings/performance',label:'Performance settings',detail:'Daily working-hours target'},
   {href:'/calendar',label:'Calendar',detail:'Events and appointments'},
  ]:[]),
  ...(access.canViewFinance?[{href:'/finance',label:'Finance overview',detail:'Bank statements, rates and approvals'},{href:'/billing',label:'Billing',detail:'Invoices and credit notes'},{href:'/accounts',label:'Accounts',detail:'Client and office money'}]:[]),
  ...(access.canViewCompliance?[{href:'/compliance',label:'Compliance',detail:'AML, sanctions and regulatory controls'}]:[]),
  ...(access.canViewHr?[{href:'/hr',label:'HR workspace',detail:'Personnel administration and leave'}]:[]),
  {href:'/reports',label:'Reports',detail:'Financial and governance reporting'},
  {href:'/notifications',label:'Notifications',detail:'Updates and reminders'},
  {href:'/policies',label:'Policies & guidance',detail:'Approved practice policies'},
  {href:'/report-concern',label:'Report a concern',detail:'Protected reporting process'},
  {href:'/people',label:'Team directory',detail:'People in your firm'},
  {href:'/settings',label:'Settings',detail:'Account settings'},
  {href:'/help',label:'Help & guides',detail:'Help with your workspace'},
 ];
}
