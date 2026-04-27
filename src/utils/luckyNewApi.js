const axios = require('axios');
const db = require('../db');
const logger = require('./logger');

const BASE_URL = process.env.LUCKMAIL_BASE_URL || "https://luckmail.monsterx.site";

const ALLOWED_DOMAINS = ["outlook.jp"];

function createApiClient(apiKey) {
    const apiClientOpts = {
        baseURL: BASE_URL,
        headers: {
            'X-API-Key': apiKey,
            'Content-Type': 'application/json'
        }
    };

    const proxyUrl = process.env.GENERAL_PROXY_URL;
    if (proxyUrl) {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        apiClientOpts.httpsAgent = new HttpsProxyAgent(proxyUrl);
        apiClientOpts.proxy = false;
    }

    return axios.create(apiClientOpts);
}

/**
 * Membeli slot email baru dari Lucky New
 * @param {string} apiKey - API Key Lucky New dari user
 * @param {string[]} domains - Array domain yang dikonfigurasi user
 * @returns {Promise<{orderId: string, email: string}>}
 */
async function purchaseEmail(apiKey, domains) {
    try {
        if (!apiKey) {
            throw new Error("No Lucky New API key configured. Go to ⚙️ My Settings to add yours.");
        }

        // Pilih domain secara acak dari yang diset user, fallback ke allowed domains
        const validDomains = (domains && domains.length > 0) ? domains : ALLOWED_DOMAINS;
        const randomDomain = validDomains[Math.floor(Math.random() * validDomains.length)];
        logger.info(`[Lucky New] Menyiapkan pembelian email dengan domain: ${randomDomain}`);

        const apiClient = createApiClient(apiKey);
        const response = await apiClient.post('/api/v1/openapi/email/purchase', {
            project_code: "openai",
            email_type: "ms_graph",
            domain: randomDomain,
            quantity: 1
        });

        const resData = response.data;
        if (resData && resData.data && resData.data.purchases && resData.data.purchases[0]) {
            const purchase = resData.data.purchases[0];
            const token = purchase.token;
            const email = purchase.email_address;
            const purchaseId = purchase.id || token; // use token as fallback if no ID

            // Simpan riwayat pembelian ke database orders.json (kita simpan token sebagai ID utilitasnya)
            db.saveOrder(token, email, 'purchased');
            logger.info(`[Lucky New] Berhasil membeli email: ${email} (Token: ${token})`);

            return { token, email, purchaseId };
        } else {
            throw new Error(resData ? resData.message || JSON.stringify(resData) : "Unknown error from Lucky New API");
        }
    } catch (error) {
        logger.error(`[Lucky New] Gagal order email: ${error.message}`);
        throw error;
    }
}

/**
 * Polling untuk mengambil OTP dari Lucky New.
 *
 * @param {string} token - Token dari email yang dibeli.
 * @param {string} email - Alamat email (untuk mengecek last_otp cache).
 * @param {string} apiKey - API Key Lucky New dari user
 * @returns {Promise<string|null>} - Kode OTP 6-digit atau null jika timeout.
 */
async function fetchVerificationCode(token, email, apiKey) {
    // 15 * 3000 = 45 detik
    const maxRetries = 15;
    const delayMs = 3000;
    const lastOtp = db.getOtpCache(email);

    logger.info(`[Lucky New] Memulai pencarian OTP untuk ${email} (Token: ${token})...`);
    if (lastOtp) {
        logger.debug(`[Lucky New] Memiliki record otp sebelumnya: ${lastOtp}, akan di-ignore.`);
    }

    const apiClient = createApiClient(apiKey);

    for (let i = 0; i < maxRetries; i++) {
        try {
            await new Promise(resolve => setTimeout(resolve, delayMs)); // Delay

            const response = await apiClient.get(`/api/v1/openapi/email/token/${encodeURIComponent(token)}/code`);

            if (response.data && response.data.data) {
                const status = response.data.data.status;
                
                if (['timeout', 'cancelled'].includes(status)) {
                    logger.warn(`[Lucky New] Order status is ${status}. Cancelling poll.`);
                    break;
                }

                if (status === 'success' && response.data.data.verification_code) {
                    const codeRaw = response.data.data.verification_code;

                    // Cari angka 6-digit dari kembalian
                    const match = String(codeRaw).match(/\b(\d{6})\b/);
                    if (match && match[1]) {
                        const extractedOtp = match[1];

                        // Validasi dengan cache, supaya tidak membaca ulang OTP
                        if (extractedOtp === lastOtp) {
                            logger.debug(`[Lucky New] Mendapatkan kode OTP ${extractedOtp} tapi ini adalah kode lama. Melanjutkan polling... (${i + 1}/${maxRetries})`);
                            continue;
                        }

                        // OTP baru didapatkan!
                        logger.success(`[Lucky New] Kode verifikasi ditemukan: ${extractedOtp}`);
                        db.saveOtpCache(email, extractedOtp); // Update chache db
                        return extractedOtp;
                    } else if (codeRaw) {
                        // Jika ada tulisan code tapi tidak ketemu angka 6 digit
                        logger.debug(`[Lucky New] Kode respons turun tapi tidak sesuai format 6-digit: ${codeRaw}`);
                    }
                }
            }
        } catch (error) {
            logger.debug(`[Lucky New] Exception saat polling kode: ${error.message}`);
        }

        if (i % 2 === 0) {
            logger.info(`[Lucky New] Menunggu OTP untuk ${email}... (~${(i + 1) * (delayMs/1000)}s)`);
        }
    }

    logger.warn(`[Lucky New] Timeout tercapai. OTP baru tidak ditemukan untuk ${email}.`);
    return null;
}

/**
 * Mengirimkan appeal karena email tidak menerima OTP
 * Lucky New docs did not explicitly implement this openapi route, so we just log.
 * @param {number|string} purchaseId
 * @param {string} apiKey
 */
async function cancelEmail(purchaseId, apiKey) {
    logger.debug(`[Lucky New] CancelEmail for ${purchaseId} is a no-op as per JS_INTEGRATION.`);
}

module.exports = {
    purchaseEmail,
    fetchVerificationCode,
    cancelEmail
};
