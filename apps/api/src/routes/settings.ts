import { isValidNzGstNumber, normaliseGstNumber } from '@opentradie/core';
import { recordAudit } from '@opentradie/database';
import { HttpError, type RouteRegistry } from '../http.js';
import { businessSettingsBody, businessSettingsResponse, errorResponse } from '../schemas.js';
import { loadBusiness, type Business } from '../services/records.js';

const settingsDto = (business: Business) => ({
  gstRegistered: business.gstRegistered,
  gstNumber: business.gstNumber,
  pricesEntered: business.pricesEntered,
  quoteValidityDays: business.quoteValidityDays,
  defaultMaterialMarkupBasisPoints: business.defaultMaterialMarkupBasisPoints,
  taxBasisPoints: business.taxBasisPoints,
  paymentTermsDays: business.paymentTermsDays,
  accountingSalesAccountCode: business.accountingSalesAccountCode,
});

export function registerSettingsRoutes(api: RouteRegistry) {
  api.route(
    {
      method: 'GET',
      url: '/api/settings/business',
      summary: 'Business GST and quoting settings',
      tags: ['settings'],
      auth: 'user',
      responses: { 200: { description: 'Settings', schema: businessSettingsResponse } },
    },
    async ({ user }) => ({ body: settingsDto(await loadBusiness(api.pool, user.tenantId)) }),
  );

  api.route(
    {
      method: 'PATCH',
      url: '/api/settings/business',
      summary:
        'Owner updates GST registration, GST number (IRD check digit validated), price entry mode, quote validity, default material markup, invoice payment terms and the accounting sales account code. Existing quotes and invoices keep the settings they were priced with.',
      tags: ['settings'],
      auth: 'owner',
      idempotent: true,
      body: businessSettingsBody,
      responses: {
        200: { description: 'Updated settings', schema: businessSettingsResponse },
        403: { description: 'OWNER_REQUIRED', schema: errorResponse },
        422: { description: 'INVALID_GST_NUMBER or GST_NUMBER_REQUIRED', schema: errorResponse },
      },
    },
    async ({ user, body, request, idempotent }) =>
      idempotent(async (client) => {
        const current = await loadBusiness(client, user.tenantId);
        let gstNumber = current.gstNumber;
        if (body.gstNumber !== undefined) {
          if (body.gstNumber === null || body.gstNumber === '') gstNumber = null;
          else {
            const digits = normaliseGstNumber(body.gstNumber);
            if (!digits || !isValidNzGstNumber(digits))
              throw new HttpError(
                422,
                'INVALID_GST_NUMBER',
                'That is not a valid NZ GST number. Check the 8 or 9 digits on your IRD registration.',
              );
            gstNumber = digits;
          }
        }
        const next = {
          gstRegistered: body.gstRegistered ?? current.gstRegistered,
          gstNumber,
          pricesEntered: body.pricesEntered ?? current.pricesEntered,
          quoteValidityDays: body.quoteValidityDays ?? current.quoteValidityDays,
          defaultMaterialMarkupBasisPoints:
            body.defaultMaterialMarkupBasisPoints ?? current.defaultMaterialMarkupBasisPoints,
          paymentTermsDays: body.paymentTermsDays ?? current.paymentTermsDays,
          accountingSalesAccountCode:
            body.accountingSalesAccountCode ?? current.accountingSalesAccountCode,
        };
        await client.query(
          `UPDATE businesses SET gst_registered=$2,gst_number=$3,prices_entered=$4,quote_validity_days=$5,default_material_markup_bp=$6,
             payment_terms_days=$7,accounting_sales_account_code=$8
           WHERE id=$1`,
          [
            user.tenantId,
            next.gstRegistered,
            next.gstNumber,
            next.pricesEntered,
            next.quoteValidityDays,
            next.defaultMaterialMarkupBasisPoints,
            next.paymentTermsDays,
            next.accountingSalesAccountCode,
          ],
        );
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'business.settings_updated',
          entityType: 'business',
          entityId: user.tenantId,
          requestId: request.id,
          metadata: {
            fields: Object.keys(body),
            gstRegistered: next.gstRegistered,
            pricesEntered: next.pricesEntered,
            gstNumberSet: next.gstNumber !== null,
          },
        });
        return { body: settingsDto(await loadBusiness(client, user.tenantId)) };
      }),
  );
}
