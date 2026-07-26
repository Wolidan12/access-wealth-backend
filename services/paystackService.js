/**
 * Paystack Transfer Service
 * Handles all Paystack API interactions for creating recipients and initiating transfers
 */

const axios = require('axios');
const crypto = require('crypto');

// Paystack API URLs
const PAYSTACK_API_BASE = 'https://api.paystack.co';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'dev-paystack-secret';

// ==========================================
// 1. CREATE PAYSTACK RECIPIENT
// ==========================================
/**
 * Creates a Paystack Transfer Recipient
 * @param {string} bank_code - Nigerian bank code (e.g., "033" for GTB)
 * @param {string} account_number - User's account number
 * @param {string} account_name - Account holder name
 * @returns {Promise} {recipient_code, recipient_id, or error}
 * 
 * Explanation:
 * - Paystack requires bank_code + account_number to identify the recipient
 * - They return a recipient_code which we use for all future transfers
 * - We store this code so we don't create duplicate recipients
 */
async function createPaystackRecipient(bank_code, account_number, account_name) {
    try {
        console.log(`[PAYSTACK] Creating recipient: ${account_name} (${bank_code} - ${account_number})`);
        
        const response = await axios.post(
            `${PAYSTACK_API_BASE}/transferrecipient`,
            {
                type: 'nuban', // NUBAN = Nigerian Universal Bank Account Number
                name: account_name,
                account_number: account_number,
                bank_code: bank_code,
                currency: 'NGN'
            },
            {
                headers: {
                    'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.status) {
            const recipient = response.data.data;
            console.log(`[PAYSTACK] ✅ Recipient created: ${recipient.recipient_code}`);
            return {
                success: true,
                recipient_code: recipient.recipient_code,
                recipient_id: recipient.id,
                recipient_name: recipient.name
            };
        } else {
            console.error('[PAYSTACK] Failed to create recipient:', response.data.message);
            return {
                success: false,
                error: response.data.message || 'Failed to create recipient'
            };
        }
    } catch (error) {
        console.error('[PAYSTACK] Error creating recipient:', error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data?.message || error.message
        };
    }
}

// ==========================================
// 2. INITIATE PAYSTACK TRANSFER
// ==========================================
/**
 * Initiates a money transfer using Paystack API
 * @param {string} recipient_code - Paystack recipient code (from createPaystackRecipient)
 * @param {number} amount - Amount in kobo (1 NGN = 100 kobo)
 * @param {string} reason - Transfer reason/description
 * @returns {Promise} {transfer_code, transfer_id, reference, or error}
 * 
 * Explanation:
 * - Paystack expects amount in kobo (divide NGN by 100)
 * - They return a transfer_code we can use to track the transfer
 * - The transfer is QUEUED, not immediate - we wait for webhook confirmation
 */
async function initiatePaystackTransfer(recipient_code, amount_ngn, reason = 'Withdrawal') {
    try {
        // Convert NGN to kobo
        const amount_kobo = Math.round(amount_ngn * 100);
        
        console.log(`[PAYSTACK] Initiating transfer: ${amount_ngn} NGN (${amount_kobo} kobo) to ${recipient_code}`);
        
        const response = await axios.post(
            `${PAYSTACK_API_BASE}/transfer`,
            {
                source: 'balance', // Transfer from our Paystack balance
                recipient: recipient_code,
                amount: amount_kobo,
                reason: reason,
                currency: 'NGN'
            },
            {
                headers: {
                    'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.status) {
            const transfer = response.data.data;
            console.log(`[PAYSTACK] ✅ Transfer initiated: ${transfer.reference}`);
            return {
                success: true,
                transfer_code: transfer.transfer_code,
                reference: transfer.reference,
                status: transfer.status
            };
        } else {
            console.error('[PAYSTACK] Failed to initiate transfer:', response.data.message);
            return {
                success: false,
                error: response.data.message || 'Failed to initiate transfer'
            };
        }
    } catch (error) {
        console.error('[PAYSTACK] Error initiating transfer:', error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data?.message || error.message
        };
    }
}

// ==========================================
// 3. VERIFY PAYSTACK WEBHOOK SIGNATURE
// ==========================================
/**
 * Verifies that a webhook came from Paystack using HMAC signature
 * @param {string} body - Raw request body as string
 * @param {string} signature - x-paystack-signature header value
 * @returns {boolean} True if signature is valid
 * 
 * Explanation:
 * - Paystack sends a signature header with every webhook
 * - We compute HMAC-SHA512(body, secret) and compare with the signature
 * - This ensures the webhook really came from Paystack, not an attacker
 */
function verifyPaystackWebhookSignature(body, signature) {
    try {
        // Compute HMAC-SHA512 of the body using the Paystack secret
        const hash = crypto
            .createHmac('sha512', PAYSTACK_SECRET_KEY)
            .update(body)
            .digest('hex');

        // Compare with the signature from the header
        const isValid = hash === signature;
        
        if (!isValid) {
            console.warn('[PAYSTACK WEBHOOK] ❌ Invalid signature - possible attack');
        } else {
            console.log('[PAYSTACK WEBHOOK] ✅ Signature verified');
        }
        
        return isValid;
    } catch (error) {
        console.error('[PAYSTACK WEBHOOK] Error verifying signature:', error.message);
        return false;
    }
}

// ==========================================
// 4. PARSE TRANSFER EVENT FROM WEBHOOK
// ==========================================
/**
 * Extracts relevant transfer information from Paystack webhook event
 * @param {object} event - Event object from Paystack
 * @returns {object} Parsed event data
 * 
 * Explanation:
 * - Paystack sends different event types: transfer.success, transfer.failed, transfer.reversed
 * - We extract the relevant data and normalize it for our use
 */
function parseTransferEvent(event) {
    if (!event || !event.data) {
        return null;
    }

    const transfer = event.data;
    return {
        event_type: event.event, // 'transfer.success', 'transfer.failed', etc.
        reference: transfer.reference,
        recipient: transfer.recipient,
        amount: transfer.amount / 100, // Convert kobo back to NGN
        status: transfer.status, // 'success', 'failed', etc.
        reason: transfer.reason,
        failures: transfer.failures // Error details if failed
    };
}

module.exports = {
    createPaystackRecipient,
    initiatePaystackTransfer,
    verifyPaystackWebhookSignature,
    parseTransferEvent
};
