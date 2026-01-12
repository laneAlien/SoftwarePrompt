export interface FeeModelGate {
    makerRate: number;
    takerRate: number;
    gtDiscountRate?: number;
    voucherDiscountRate?: number;
    voucherDiscountFixed?: number;
    minimumFee?: number;
    roundingStep?: number;
}

export interface FeeBreakdown {
    feeGross: number;
    feeNet: number;
    discounts: {
        gt: number;
        voucher: number;
    };
}

const DEFAULT_ROUNDING_STEP = 1e-8;

function roundFee(value: number, step: number): number {
    if (step <= 0) return value;
    return Math.ceil(value / step) * step;
}

export function calculateFee(
    notional: number,
    isMaker: boolean,
    model: FeeModelGate
): FeeBreakdown {
    const rate = isMaker ? model.makerRate : model.takerRate;
    const feeGross = Math.max(0, notional * rate);
    let feeNet = feeGross;
    let gtDiscount = 0;
    let voucherDiscount = 0;

    if (model.gtDiscountRate && model.gtDiscountRate > 0) {
        gtDiscount = feeNet * model.gtDiscountRate;
        feeNet -= gtDiscount;
    }

    if (model.voucherDiscountRate && model.voucherDiscountRate > 0) {
        const rateDiscount = feeNet * model.voucherDiscountRate;
        voucherDiscount += rateDiscount;
        feeNet -= rateDiscount;
    }

    if (model.voucherDiscountFixed && model.voucherDiscountFixed > 0) {
        voucherDiscount += Math.min(model.voucherDiscountFixed, feeNet);
        feeNet -= Math.min(model.voucherDiscountFixed, feeNet);
    }

    const minimumFee = model.minimumFee ?? 0;
    if (feeNet < minimumFee) {
        feeNet = minimumFee;
    }

    feeNet = roundFee(feeNet, model.roundingStep ?? DEFAULT_ROUNDING_STEP);

    return {
        feeGross,
        feeNet,
        discounts: {
            gt: gtDiscount,
            voucher: voucherDiscount,
        },
    };
}
