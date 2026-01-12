import fs from 'fs';
import { parse } from 'csv-parse/sync';

export interface LedgerEntry {
    time: string;
    action: string;
    amount: number;
    currency: string;
    fee?: number;
    feeCurrency?: string;
    side?: 'buy' | 'sell';
    price?: number;
    amountBase?: number;
    amountQuote?: number;
    pair?: string;
    raw: Record<string, string>;
}

export interface LedgerMetrics {
    realizedPnl: number;
    feesTotal: number;
    feesByCurrency: Record<string, number>;
    turnover: number;
    avgProfitPerTrade: number;
    feeRatio: number;
    tradesCount: number;
    tradesPerHour: number;
    startTime?: string;
    endTime?: string;
}

export interface LedgerMetricsOptions {
    quoteCurrency?: string;
    gtPrice?: number;
}

function parseAmountCurrency(value: string): { amount: number; currency: string } | null {
    const match = value.match(/([-\d.]+)\s*([A-Za-z0-9]+)/);
    if (!match) return null;
    return {
        amount: parseFloat(match[1]),
        currency: match[2],
    };
}

function parseNumber(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function detectSide(action: string, raw: Record<string, string>): 'buy' | 'sell' | undefined {
    const side = raw.side?.toLowerCase();
    if (side === 'buy' || side === 'sell') return side;
    const actionLower = action.toLowerCase();
    if (actionLower.includes('buy')) return 'buy';
    if (actionLower.includes('sell')) return 'sell';
    return undefined;
}

function detectPair(raw: Record<string, string>): string | undefined {
    return raw.currency_pair || raw.symbol || raw.pair || raw.market;
}

export function importLedger(filePath: string): LedgerEntry[] {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const records = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        delimiter: ',',
        trim: true,
    });

    return records.map((record: Record<string, string>) => {
        const changeStr = record.change_amount || record.change || '';
        const amountMatch = parseAmountCurrency(changeStr);
        const feeMatch = record.fee ? parseAmountCurrency(record.fee) : null;
        const price = parseNumber(record.price || record.trade_price);
        const amountBase = parseNumber(record.amount || record.trade_amount || record.quantity);
        const amountQuote = parseNumber(record.total || record.quote_amount);
        const action = record.action_desc || record.action || record.type || '';

        return {
            time: record.time || record.created || record.timestamp || '',
            action,
            amount: amountMatch?.amount ?? 0,
            currency: amountMatch?.currency ?? '',
            fee: feeMatch?.amount,
            feeCurrency: feeMatch?.currency,
            side: detectSide(action, record),
            price,
            amountBase,
            amountQuote,
            pair: detectPair(record),
            raw: record,
        };
    });
}

export function calculateLedgerMetrics(entries: LedgerEntry[], options: LedgerMetricsOptions = {}): LedgerMetrics {
    const quoteCurrency = options.quoteCurrency ?? 'USDT';
    const gtPrice = options.gtPrice ?? 0;
    const feesByCurrency: Record<string, number> = {};
    let feesTotal = 0;
    let turnover = 0;
    let realizedPnl = 0;
    let tradesCount = 0;

    const positions = new Map<string, { baseQty: number; avgCost: number }>();

    const sortedEntries = [...entries].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    const startTime = sortedEntries[0]?.time;
    const endTime = sortedEntries[sortedEntries.length - 1]?.time;

    for (const entry of sortedEntries) {
        const isTrade = entry.side && (entry.amountBase || entry.amountQuote || entry.price);
        if (entry.fee && entry.feeCurrency) {
            feesByCurrency[entry.feeCurrency] = (feesByCurrency[entry.feeCurrency] ?? 0) + entry.fee;
            if (entry.feeCurrency === quoteCurrency) {
                feesTotal += entry.fee;
            } else if (entry.feeCurrency === 'GT' && gtPrice > 0) {
                feesTotal += entry.fee * gtPrice;
            }
        }

        if (!isTrade || !entry.side || !entry.pair) {
            continue;
        }

        const price = entry.price ?? (entry.amountQuote && entry.amountBase ? entry.amountQuote / entry.amountBase : undefined);
        if (!price) continue;

        const baseQty = entry.amountBase ?? (entry.amountQuote ? entry.amountQuote / price : undefined);
        if (!baseQty) continue;

        const notional = entry.amountQuote ?? baseQty * price;
        turnover += Math.abs(notional);
        tradesCount += 1;

        const position = positions.get(entry.pair) ?? { baseQty: 0, avgCost: 0 };

        if (entry.side === 'buy') {
            const newQty = position.baseQty + baseQty;
            const cost = Math.abs(notional);
            position.avgCost = newQty > 0 ? (position.avgCost * position.baseQty + cost) / newQty : 0;
            position.baseQty = newQty;
        } else {
            const pnl = (price - position.avgCost) * baseQty;
            realizedPnl += pnl;
            position.baseQty = Math.max(0, position.baseQty - baseQty);
            if (position.baseQty === 0) {
                position.avgCost = 0;
            }
        }

        positions.set(entry.pair, position);
    }

    const durationHours = startTime && endTime
        ? Math.max(0.0001, (new Date(endTime).getTime() - new Date(startTime).getTime()) / 3600000)
        : 0;

    return {
        realizedPnl,
        feesTotal,
        feesByCurrency,
        turnover,
        avgProfitPerTrade: tradesCount > 0 ? realizedPnl / tradesCount : 0,
        feeRatio: turnover > 0 ? feesTotal / turnover : 0,
        tradesCount,
        tradesPerHour: durationHours > 0 ? tradesCount / durationHours : 0,
        startTime,
        endTime,
    };
}
