import fs from 'fs';
import { parse } from 'csv-parse/sync';

export interface LedgerEntry {
    time: string;
    action: string;
    actionType: LedgerActionType;
    side?: TradeSide;
    amount: number;
    currency: string;
    fee?: number;
    feeCurrency?: string;
    tradeId?: string;
}

export type LedgerActionType = 'trade' | 'fee' | 'transfer' | 'other';
export type TradeSide = 'buy' | 'sell';

export interface LedgerSummary {
    tradesCount: number;
    realizedPnlGross: number;
    realizedPnlNet: number;
    turnover: number;
    avgProfitPerTrade: number;
    feeRatio: number;
    tradesPerHour: number;
    feesByCurrency: Record<string, number>;
    totalFeesInQuote: number;
    totalFeesInGt: number;
    gtFeeInQuote: number;
    gtPriceInQuote: number | null;
    startTime: Date | null;
    endTime: Date | null;
}

const STABLE_QUOTES = new Set(['USDT', 'USDC', 'USD', 'BUSD', 'DAI', 'TUSD']);

function normalizeAction(actionDesc: string): { actionType: LedgerActionType; side?: TradeSide } {
    const normalized = actionDesc.toLowerCase();
    if (
        normalized.includes('комисс') ||
        normalized.includes('commission') ||
        normalized.includes('fee') ||
        normalized.includes('spot trade fee') ||
        normalized.includes('spot fee')
    ) {
        return { actionType: 'fee' };
    }
    if (normalized.includes('куп') || normalized.includes('buy')) {
        return { actionType: 'trade', side: 'buy' };
    }
    if (normalized.includes('продаж') || normalized.includes('sell')) {
        return { actionType: 'trade', side: 'sell' };
    }
    if (normalized.includes('spot trade') || normalized.includes('spot order') || normalized.includes('trade')) {
        return { actionType: 'trade' };
    }
    if (
        normalized.includes('deposit') ||
        normalized.includes('withdraw') ||
        normalized.includes('transfer') ||
        normalized.includes('internal transfer') ||
        normalized.includes('spot transfer') ||
        normalized.includes('margin transfer')
    ) {
        return { actionType: 'transfer' };
    }
    if (
        normalized.includes('promo') ||
        normalized.includes('bonus') ||
        normalized.includes('reward') ||
        normalized.includes('rebate') ||
        normalized.includes('airdrop') ||
        normalized.includes('lending') ||
        normalized.includes('staking')
    ) {
        return { actionType: 'other' };
    }
    return { actionType: 'other' };
}

function parseAmount(changeStr: string): { amount: number; currency: string } {
    const amountMatch = changeStr.match(/([-\d.]+)\s*([A-Za-z]+)/);
    return {
        amount: amountMatch ? parseFloat(amountMatch[1]) : 0,
        currency: amountMatch ? amountMatch[2] : ''
    };
}

export function importLedger(filePath: string): LedgerEntry[] {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const records = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        delimiter: ',',
        trim: true,
        bom: true,
        relax_column_count: true
    });

    return records.map((r: any) => {
        const changeStr = r.change_amount || "";
        const { amount, currency } = parseAmount(changeStr);
        const actionDesc = (r.action_desc || '').toString().trim();
        const normalized = normalizeAction(actionDesc);
        return {
            time: r.time,
            action: actionDesc,
            actionType: normalized.actionType,
            side: normalized.side,
            amount,
            currency,
            tradeId: r.action_data ? r.action_data.toString().trim() : undefined
        };
    });
}

export function analyzeLedger(entries: LedgerEntry[]): LedgerSummary {
    const tradeGroups = new Map<string, LedgerEntry[]>();
    const feesByCurrency: Record<string, number> = {};
    const tradeTimes: number[] = [];

    entries.forEach((entry, index) => {
        if (entry.actionType === 'fee') {
            const feeValue = Math.abs(entry.amount);
            if (!feesByCurrency[entry.currency]) {
                feesByCurrency[entry.currency] = 0;
            }
            feesByCurrency[entry.currency] += feeValue;
            return;
        }
        if (entry.actionType !== 'trade') {
            return;
        }
        const key = entry.tradeId || `trade-${index}`;
        if (!tradeGroups.has(key)) {
            tradeGroups.set(key, []);
        }
        tradeGroups.get(key)?.push(entry);
    });

    const positionByAsset = new Map<string, { qty: number; cost: number }>();
    let realizedPnlGross = 0;
    let turnover = 0;
    let gtQuoteValue = 0;
    let gtBaseValue = 0;

    for (const group of tradeGroups.values()) {
        const totals = new Map<string, number>();
        for (const entry of group) {
            totals.set(entry.currency, (totals.get(entry.currency) || 0) + entry.amount);
        }
        const currencies = Array.from(totals.keys()).filter((currency) => totals.get(currency));
        if (currencies.length < 2) {
            continue;
        }

        const quoteCurrency = currencies.find((currency) => STABLE_QUOTES.has(currency));
        if (!quoteCurrency) {
            continue;
        }

        const baseCurrency = currencies.find((currency) => currency !== quoteCurrency);
        if (!baseCurrency) {
            continue;
        }

        const baseDelta = totals.get(baseCurrency) || 0;
        const quoteDelta = totals.get(quoteCurrency) || 0;
        turnover += Math.abs(quoteDelta);

        if (baseCurrency === 'GT' && quoteCurrency) {
            gtQuoteValue += Math.abs(quoteDelta);
            gtBaseValue += Math.abs(baseDelta);
        }

        const tradeTime = Date.parse(group[0].time);
        if (!Number.isNaN(tradeTime)) {
            tradeTimes.push(tradeTime);
        }

        if (!positionByAsset.has(baseCurrency)) {
            positionByAsset.set(baseCurrency, { qty: 0, cost: 0 });
        }
        const position = positionByAsset.get(baseCurrency)!;

        if (baseDelta > 0) {
            const cost = Math.abs(quoteDelta);
            position.qty += baseDelta;
            position.cost += cost;
        } else if (baseDelta < 0) {
            const sellQty = Math.abs(baseDelta);
            const proceeds = Math.abs(quoteDelta);
            const avgCost = position.qty > 0 ? position.cost / position.qty : 0;
            realizedPnlGross += proceeds - avgCost * sellQty;
            position.qty = Math.max(0, position.qty - sellQty);
            position.cost = Math.max(0, position.cost - avgCost * sellQty);
        }
    }

    const tradesCount = tradeGroups.size;
    const startTime = tradeTimes.length ? new Date(Math.min(...tradeTimes)) : null;
    const endTime = tradeTimes.length ? new Date(Math.max(...tradeTimes)) : null;
    const hours = startTime && endTime ? Math.max((endTime.getTime() - startTime.getTime()) / 3600000, 0) : 0;
    const tradesPerHour = hours > 0 ? tradesCount / hours : tradesCount;

    const totalFeesInQuote = Object.entries(feesByCurrency).reduce((sum, [currency, amount]) => {
        if (STABLE_QUOTES.has(currency)) {
            return sum + amount;
        }
        return sum;
    }, 0);

    const totalFeesInGt = feesByCurrency.GT || 0;
    const gtPriceInQuote = gtBaseValue > 0 ? gtQuoteValue / gtBaseValue : null;
    const gtFeeInQuote = gtPriceInQuote ? totalFeesInGt * gtPriceInQuote : 0;
    const totalFeesInQuoteWithGt = totalFeesInQuote + gtFeeInQuote;
    const realizedPnlNet = realizedPnlGross - totalFeesInQuoteWithGt;
    const avgProfitPerTrade = tradesCount > 0 ? realizedPnlNet / tradesCount : 0;
    const feeRatio = turnover > 0 ? totalFeesInQuoteWithGt / turnover : 0;

    return {
        tradesCount,
        realizedPnlGross,
        realizedPnlNet,
        turnover,
        avgProfitPerTrade,
        feeRatio,
        tradesPerHour,
        feesByCurrency,
        totalFeesInQuote: totalFeesInQuoteWithGt,
        totalFeesInGt,
        gtFeeInQuote,
        gtPriceInQuote,
        startTime,
        endTime
    };
}
