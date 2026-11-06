/** Реквизиты продавца в оферте (/offer) — из backend/payment.config.js через /api/payment. */

import { paymentApi } from '../services/api.js?v=4';

export function initOfferPage(el) {
  paymentApi.info()
    .then(({ seller }) => {
      if (!seller?.name) return;
      el.textContent = `Продавец: ${seller.name}${seller.bin ? `, БИН ${seller.bin}` : ''}.`;
      el.hidden = false;
    })
    .catch(() => { /* без реквизитов оферта остаётся с названием и адресом */ });
}
