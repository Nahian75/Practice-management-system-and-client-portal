export function metricPeriods(today: string) {
  const day=new Date(`${today}T12:00:00Z`);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(today)||!Number.isFinite(day.getTime())||day.toISOString().slice(0,10)!==today)throw new Error('Invalid metric date');
  const iso=(date:Date)=>date.toISOString().slice(0,10);
  const week=new Date(day);week.setUTCDate(week.getUTCDate()-(week.getUTCDay()+6)%7);
  const weekEnd=new Date(week);weekEnd.setUTCDate(weekEnd.getUTCDate()+6);
  const monthStart=new Date(Date.UTC(day.getUTCFullYear(),day.getUTCMonth(),1,12));
  const monthEnd=new Date(Date.UTC(day.getUTCFullYear(),day.getUTCMonth()+1,0,12));
  const year=day.getUTCFullYear();
  return [{key:'today',label:'Today',from:today,to:today},{key:'week',label:'This Week',from:iso(week),to:iso(weekEnd)},
    {key:'month',label:'This Month',from:iso(monthStart),to:iso(monthEnd)},{key:'year',label:'This Year',from:`${year}-01-01`,to:`${year}-12-31`}]
    .map(period=>{let weekdays=0;for(let date=new Date(`${period.from}T12:00:00Z`);iso(date)<=period.to;date.setUTCDate(date.getUTCDate()+1)){if(date.getUTCDay()!==0&&date.getUTCDay()!==6)weekdays++;}return {...period,weekdays};});
}
export const businessDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
