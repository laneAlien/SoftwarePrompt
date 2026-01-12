export interface FeeModel {
    maker: number;
    taker: number;
    gtDiscount: boolean;
    voucherDiscount: number;
}

export function calculateFee(
    amount: number,
    price: number,
    isMaker: boolean,
    model: FeeModel
): number {
    const rate = isMaker ? model.maker : model.taker;
    let fee = amount * price * rate;
    
    if (model.gtDiscount) {
        fee *= 0.75; // Example 25% discount for GT
    }
    
    fee = Math.max(0, fee - model.voucherDiscount);
    return fee;
}
