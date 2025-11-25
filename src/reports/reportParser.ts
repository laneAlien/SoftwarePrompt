import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse';
import * as XLSX from 'xlsx';

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

function readCsvLike(filePath: string): Promise<ReportRow[]> {
  return new Promise((resolve, reject) => {
    const rows: ReportRow[] = [];
    const parser = fs
      .createReadStream(filePath)
      .pipe(
        parse({
          columns: true,
          relaxColumnCount: true,
          delimiter: undefined,
          skipEmptyLines: true,
          trim: true,
        })
      );

    parser.on('data', (record: Record<string, string>) => {
      const headers = normalizeHeaders(Object.keys(record));
      const values = Object.values(record);
      const lookup = (keyVariants: string[]): number => {
        const idx = headers.findIndex((h) => keyVariants.includes(h));
        if (idx === -1) return 0;
        const raw = values[idx];
        const parsed = Number(raw?.toString().replace(/[^0-9.-]/g, ''));
        return Number.isFinite(parsed) ? parsed : 0;
      };

      rows.push({
        day: lookup(['day', 'день', 'date']),
        spent: lookup(['spent', 'ушло всего за заход', 'expenses', 'costs']),
        voucherIncome: lookup(['voucher income', 'пришло с ваучера', 'voucher', 'income']),
        profit: lookup(['profit', 'профит', 'pnl']),
      });
    });

    parser.on('error', reject);
    parser.on('end', () => resolve(rows));
  });
}

function readExcel(filePath: string): ReportRow[] {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: '' });
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
    rows = await readCsvLike(resolved);
  }

  return summarize(rows);
}

