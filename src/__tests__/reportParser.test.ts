import fs from 'fs';
import path from 'path';
import { parseReport } from '../reports/reportParser';

describe('reportParser', () => {
  const tmp = path.join(__dirname, 'tmp-report.csv');

  beforeAll(() => {
    fs.writeFileSync(tmp, 'day,spent,voucherIncome,profit\n1,100,50,10\n2,200,0,-20');
  });

  afterAll(() => {
    fs.unlinkSync(tmp);
  });

  it('summarizes CSV rows', async () => {
    const summary = await parseReport(tmp);
    expect(summary.totalSpent).toBe(300);
    expect(summary.totalVoucherIncome).toBe(50);
    expect(summary.totalProfit).toBe(-10);
    expect(summary.avgDailyProfit).toBeCloseTo(-5);
  });
});
