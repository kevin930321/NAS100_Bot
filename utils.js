/**
 * NAS100 Bot - 共用工具函數
 */

const API_PRICE_MULTIPLIER = 100000;
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

// 轉換 Protobuf Long 物件為 JavaScript Number
function convertLongValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object' && value.toNumber) return value.toNumber();
    return typeof value === 'number' ? value : Number(value);
}

// Raw Price (API) -> 真實價格
function rawToRealPrice(rawPrice) {
    return rawPrice / API_PRICE_MULTIPLIER;
}

// 真實價格 -> Raw Price (API)
function realToRawPrice(realPrice) {
    return realPrice * API_PRICE_MULTIPLIER;
}

// 取得台北時間
function getTaipeiTime() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}

// 取得台北時間日期字串 (YYYY-MM-DD)
function getTaipeiDateString(date = new Date()) {
    return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

// 判斷美股夏令時間 (DST: 3月第2週日 ~ 11月第1週日)
function isUsDst(date) {
    const year = date.getFullYear();

    // 3月第2個週日
    let dstStart = new Date(year, 2, 1);
    while (dstStart.getDay() !== 0) dstStart.setDate(dstStart.getDate() + 1);
    dstStart.setDate(dstStart.getDate() + 7);

    // 11月第1個週日
    let dstEnd = new Date(year, 10, 1);
    while (dstEnd.getDay() !== 0) dstEnd.setDate(dstEnd.getDate() + 1);

    return date >= dstStart && date < dstEnd;
}

module.exports = {
    API_PRICE_MULTIPLIER,
    TAIPEI_OFFSET_MS,
    convertLongValue,
    rawToRealPrice,
    realToRawPrice,
    getTaipeiTime,
    getTaipeiDateString,
    isUsDst
};

