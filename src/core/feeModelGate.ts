export interface FeeModel {
    makerRate: number;
    takerRate: number;
    gtDiscountRate: number;
    voucherDiscount?: {
        type: 'percent' | 'fixed';
        value: number;
    };
    minimumFee: number;
    roundingDecimals?: number;
}

export function calculateFee(
    notional: number,
    isMaker: boolean,
    model: FeeModel
): number {
    const rate = isMaker ? model.makerRate : model.takerRate;
    const baseFee = notional * rate;
    let fee = baseFee;

    if (model.gtDiscountRate > 0) {
        fee *= 1 - model.gtDiscountRate / 100;
    }

    if (model.voucherDiscount) {
        if (model.voucherDiscount.type === 'percent') {
            fee -= fee * (model.voucherDiscount.value / 100);
        } else {
            fee -= model.voucherDiscount.value;
        }
    }

    fee = Math.max(0, fee);
    fee = Math.max(model.minimumFee, fee);

    if (model.roundingDecimals !== undefined) {
        const factor = 10 ** model.roundingDecimals;
        fee = Math.round(fee * factor) / factor;
    }

    return Math.max(model.minimumFee, fee);
}
