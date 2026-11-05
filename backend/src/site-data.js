/**
 * Данные для GET /api/site. Единый источник — frontend/assets/js/config/site-data.js
 * (README: «он и есть полный эталон формы»), поэтому данные не дублируются.
 * JSON и ETag считаются один раз при старте.
 */

import { createHash } from 'node:crypto';
import { SITE_DATA } from '../../frontend/assets/js/config/site-data.js';

export function buildSitePayload(data = SITE_DATA) {
  const json = JSON.stringify(data);
  const etag = `"${createHash('sha1').update(json).digest('base64url')}"`;
  return { json, etag };
}
