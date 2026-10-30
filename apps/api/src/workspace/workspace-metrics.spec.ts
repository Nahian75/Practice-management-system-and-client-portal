import {describe,it,expect} from 'vitest';
import {metricPeriods} from './workspace-metrics.js';
describe('Performance calendar ranges',()=>{
  it('uses a Monday-based week across year boundaries and leap-month weekdays',()=>{
    const periods=metricPeriods('2028-01-01');expect(periods[1]).toMatchObject({from:'2027-12-27',to:'2028-01-02',weekdays:5});
    expect(metricPeriods('2028-02-29')[2]).toMatchObject({from:'2028-02-01',to:'2028-02-29',weekdays:21});
    expect(periods[0]!.weekdays).toBe(0);
  });
  it('rejects dates that would silently roll into another month',()=>{expect(()=>metricPeriods('2027-02-30')).toThrow();});
});
