import fs from 'fs';
import path from 'path';

let xlsx: any;

export interface ReportRow {
  day: number;
  spent: number;
  voucherIncome: number;
  profit: number;
}

export interface ReportSummary {
  totalSpent: number;
  totalVoucherIncome: number;
  totalProfit: number;
  avgDailyProfit: number;
}

function normalizeHeaders(headers: string[]): string[] {
  return headers.map((h) => h.trim().toLowerCase());
}

function readCsvLike(filePath: string): ReportRow[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) return [];

  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const headers = normalizeHeaders(lines[0].split(delimiter));
  const rows: ReportRow[] = [];

  const lookup = (headers: string[], values: string[], keyVariants: string[]): number => {
    const idx = headers.findIndex((h) => keyVariants.includes(h));
    if (idx === -1) return 0;
    const raw = values[idx];
    const parsed = Number(raw?.toString().replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delimiter);
    rows.push({
      day: lookup(headers, cols, ['day', 'день', 'date']),
      spent: lookup(headers, cols, ['spent', 'ушло всего за заход', 'expenses', 'costs']),
      voucherIncome: lookup(headers, cols, ['voucher income', 'voucherincome', 'пришло с ваучера', 'voucher', 'income']),
      profit: lookup(headers, cols, ['profit', 'профит', 'pnl']),
    });
  }

  return rows;
}

function readExcel(filePath: string): ReportRow[] {
  if (!xlsx) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      xlsx = require('xlsx');
    } catch (err) {
      throw new Error('xlsx dependency not found. Please install "xlsx" to parse Excel reports.');
    }
  }

  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const json = xlsx.utils.sheet_to_json<Record<string, any>>(sheet, { defval: '' });
  return json.map((record) => {
    const headers = normalizeHeaders(Object.keys(record));
    const values = Object.values(record);
    const lookup = (keyVariants: string[]): number => {
      const idx = headers.findIndex((h) => keyVariants.includes(h));
      if (idx === -1) return 0;
      const raw = values[idx];
      const parsed = Number(raw?.toString().replace(/[^0-9.-]/g, ''));
      return Number.isFinite(parsed) ? parsed : 0;
    };

    return {
      day: lookup(['day', 'день', 'date']),
      spent: lookup(['spent', 'ушло всего за заход', 'expenses', 'costs']),
      voucherIncome: lookup(['voucher income', 'пришло с ваучера', 'voucher', 'income']),
      profit: lookup(['profit', 'профит', 'pnl']),
    };
  });
}

function summarize(rows: ReportRow[]): ReportSummary {
  const totalSpent = rows.reduce((acc, row) => acc + (row.spent || 0), 0);
  const totalVoucherIncome = rows.reduce((acc, row) => acc + (row.voucherIncome || 0), 0);
  const totalProfit = rows.reduce((acc, row) => acc + (row.profit || 0), 0);
  const avgDailyProfit = rows.length ? totalProfit / rows.length : 0;

  return { totalSpent, totalVoucherIncome, totalProfit, avgDailyProfit };
}

export async function parseReport(filePath: string): Promise<ReportSummary> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Report file not found at ${resolved}`);
  }

  const ext = path.extname(resolved).toLowerCase();
  let rows: ReportRow[] = [];
  if (['.xlsx', '.xlsm', '.xls'].includes(ext)) {
    rows = readExcel(resolved);
  } else {
    rows = readCsvLike(resolved);
  }

  return summarize(rows);
}

