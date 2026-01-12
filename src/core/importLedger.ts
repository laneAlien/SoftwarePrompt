import fs from 'fs';
import { parse } from 'csv-parse/sync';

export interface LedgerEntry {
    time: string;
    action: string;
    amount: number;
    currency: string;
    fee?: number;
    feeCurrency?: string;
}

export function importLedger(filePath: string): LedgerEntry[] {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const records = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        delimiter: ',',
        trim: true
    });

    return records.map((r: any) => {
        const changeStr = r.change_amount || "";
        const amountMatch = changeStr.match(/([-\d.]+)\s*(\w+)/);
        return {
            time: r.time,
            action: r.action_desc,
            amount: amountMatch ? parseFloat(amountMatch[1]) : 0,
            currency: amountMatch ? amountMatch[2] : '',
        };
    });
}
