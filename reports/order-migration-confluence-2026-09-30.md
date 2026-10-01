# Order Migration – commercetools to SFCC

Last updated: 30 Sep 2026

The order export is complete and verified against order.xsd and live commercetools data; the full import waits on four setup items and a sandbox reset.

## Page properties

| Property | Value |
| --- | --- |
| Status | Code complete; full import pending setup |
| Scope | Orders from commercetools project mars-mms-test-us into SFCC (sandbox zzkc-009, site RefArch) |
| Tool | Migration console, cartridge bm_accelerator (Business Manager) |
| Code branch | feature/ct-order-migration |
| Contract | SFCC order.xsd (repo copy, .cursor/references/sfcc-xsd/order.xsd) |
| Volume | 102,578 orders in the test project; about 1M expected in production |
| Depends on | Product migration (catalog), customer migration |

## Summary

The console exports every commercetools order into SFCC order XML that validates against order.xsd and matches commercetools wherever the source data is consistent.

- **Export:** all 102,578 orders export in about 5 files of up to 190 MB, in 1,000-order batches, with no 10,000-order or 50,000-order limit.
- **Correctness:** checked against 1,000 dumped and 580 live orders. Customers, products, custom line items, discounts, tax, payments, tracking and custom data are all mapped.
- **Sandbox imports:** 24,770 orders (old code) and 511 orders (new code) imported; rejections are only for customers missing from SFCC.
- **Recommendation:** do not run the final bulk import until the attributes are created, EU and US customers are split into their own lists, and the sandbox is reset. A bulk run now is useful only as a performance test.

## How the order migration works

The console reads orders from commercetools, maps them to order.xsd and writes XML files to IMPEX; the files are then imported in Business Manager.

1. **Filter and count** – the user picks a date range (1, 2, 3 years or All orders), optional order and payment state, and an optional max count. The count is exact beyond commercetools' 10,000 cap (the range is split and counted in parts).
2. **Fetch** – orders are read oldest first in pages of 20 using a cursor (createdAt, id), so there is no offset limit. Each page expands payments, workflow state and supply/distribution channels, and reads the customers' customerNumber in one extra request.
3. **Map** – each order becomes a canonical order: customer, addresses, line items with discounts, custom line items, shipping, payments, tracking and custom fields.
4. **Resolve** – each line item's commercetools product and variant become the SFCC product ID `{master}-{n}` from the imported catalog.
5. **Write** – each order is written in order.xsd sequence and validated. One request handles 1,000 orders; the page calls again until done. A new file starts before a file would pass 190 MB (Salesforce advises WebDAV downloads under 200 MB).
6. **Import** – files are imported in Merchant Tools > Ordering > Import & Export. SFCC has no standard job step for orders.

Import rules that matter: an order number that already exists is skipped, never updated; a registered order is rejected when its customer number is not in the site's customer list; customers must be imported before orders.

## Field mapping

order.xsd decides where each value goes: the native element when one exists, custom attributes only when the XSD has none.

| commercetools | order.xsd element | Native or custom |
| --- | --- | --- |
| orderNumber, createdAt, currency, locale | order-no, order-date, currency, customer-locale | Native |
| customerId + customer's customerNumber | customer/customer-no (customerNumber, else the ID), guest | Native |
| customerEmail, billingAddress | customer-email, billing-address | Native |
| shippingAddress, shippingInfo.shippingMethodName | shipment/shipping-address, shipping-method | Native |
| lineItems (product, variant, quantity, price, taxedPrice) | product-lineitem: product-id `{master}-{n}`, quantity, base-price, net/tax/gross, tax-rate | Native |
| Line discounts (discountedPricePerQuantity) | product-lineitem/price-adjustments | Native |
| Shipping price, shipping discounts | shipping-lineitem + price-adjustments | Native |
| Custom line item, credit (negative) | totals/merchandize-total/price-adjustments | Native |
| Custom line item, shipping charge | extra shipping-lineitem | Native |
| Custom line item, other (gift card, service) | product-lineitem with the item's slug as product-id | Native |
| discountOnTotalPrice | order-level price-adjustment | Native |
| taxRate.includedInPrice / taxRate.amount | taxation (gross or net) / tax-rate | Native |
| Payment (method, interface, transaction) | payment/custom-method/method-name, amount, processor-id, transaction-id, transaction-type | Native |
| Parcel tracking IDs | shipment/tracking-number | Native |
| Workflow state | external-order-status | Native |
| orderState, paymentState, shipmentState | order-status, payment-status, shipping-status | Native |
| Order custom fields | order custom-attributes | Custom (Order) |
| store, completedAt, anonymousId, customerGroup, country, discount codes | order custom-attributes | Custom (Order) |
| Line item custom fields (personalization, bundles), supply/distribution channel | product-lineitem custom-attributes | Custom (ProductLineItem) |
| Address custom fields (VAT, EORI, address type, pickup point), address email | address custom-attributes | Custom (OrderAddress) |
| Payment custom fields (card last 4, holder, references) | payment custom-attributes | Custom (OrderPaymentInstrument) |
| Custom line item fields on credits | price-adjustment custom-attributes | Custom (PriceAdjustment) |

Custom attribute IDs are the commercetools field names; Check Attributes on the order page creates them on the matching SFCC object and applies any renames.

## Issues log

17 issues are fixed in code, 3 are open, 2 need a decision and 3 turned out not to be bugs. Root cause of most mapping issues: the export followed a small generic order model instead of order.xsd, so data without a matching field was dropped silently; almost every order.xsd element is optional, so the files still validated.

| # | Issue | Impact | Fix | Status |
| --- | --- | --- | --- | --- |
| 1 | Export stopped at 50,000 orders ("too many orders for a single XML file") | 102,578 orders could not be exported | Batched export: 1,000 orders per request, state passed between requests | Fixed |
| 2 | One file per 5,000 orders | 21 files for 102,578 orders | New file only before 190 MB: 5 files | Fixed |
| 3 | commercetools offset limit (10,000) and capped count | Orders after 10,000 unreachable; count wrong | Cursor paging on createdAt + id; exact count by splitting the range | Fixed |
| 4 | Script string quota (1,000,000 chars) on large pages | Export failure risk | Pages of 20 orders (max measured 0.33M chars with expansions) | Fixed |
| 5 | No option for all orders | Only 1–3 years exportable | Date range 1, 2, 3 years or All orders | Fixed |
| 6 | Customer number: orders used the commercetools ID, customers were imported under customerNumber | 56,051 registered orders would not link | Read each customer's customerNumber (else the ID) | Fixed |
| 7 | Product ID: line items used the SKU | 0 line items linked to a catalog product | Resolve `{master}-{n}` from product and variant, confirmed by SKU | Fixed |
| 8 | Older orders used the unit price as the line total | Totals too low (one order 29.97 instead of 63.93) | Use the line total | Fixed |
| 9 | Custom line items dropped (Brexit VAT removal, B2B tax correction, shipping surcharge, greeting card) | Wrong totals on about 4% of orders | Credit: price-adjustment; shipping charge: shipping-lineitem; other: product-lineitem | Fixed |
| 10 | Discounts not recorded (items, shipping, order, codes) | Promotion detail lost on about 19% of lines | price-adjustments; line amounts before discount as SFCC expects | Fixed |
| 11 | External tax held only at order level | Tax missing on 65 of 1,000 sampled orders | Spread over the product lines by net amount | Fixed |
| 12 | Payment always written as CARD | Real payment method lost | Expand payments: method, processor (Adyen), transaction type and ID | Fixed |
| 13 | Tracking numbers dropped | No tracking on shipped orders | shipment/tracking-number | Fixed |
| 14 | Workflow state, tax rate and taxation flag lost or computed | Wrong tax rate (0.0551 for 0.055); UK/EU marked net | external-order-status; real tax-rate; taxation gross when prices include tax | Fixed |
| 15 | Line item, address, payment and extra order data dropped | Personalization, VAT/EORI, store, card details lost | Custom attributes on the matching element | Fixed |
| 16 | Set and money custom fields | Only the first value kept; money written as text | All values (set_of_string); money as a number | Fixed |
| 17 | Check Attributes only covered the Order object | New attributes could not be created | Also checks and creates ProductLineItem, OrderAddress, OrderPaymentInstrument, PriceAdjustment | Fixed |
| 18 | EU and US customers in one customer list | 396 customers skipped (same email in both stores); their orders rejected | Separate customer lists per site | Open |
| 19 | EU and US orders go to one site | Orders cannot reach the right site and customer list | Store filter on the order export | Open |
| 20 | Legacy orders whose commercetools total does not match their own lines | 34% of sampled orders differ from commercetools | Optional "difference to commercetools total" adjustment | Decision needed |
| 21 | Adyen payment methods not configured in SFCC | "Payment method does not exist" warnings | Create the 7 methods or map them in code | Decision needed |
| 22 | One customer missing from the customer export | 1 order rejected in test v005 | Check with the customer migration | Open |
| 23 | All orders exported as NEW | Looked wrong | commercetools orders are Open, which maps to NEW | Not a bug |
| 24 | Max count ignored | 30,034 orders instead of 200 | The field was empty | Not a bug |
| 25 | Re-import skipped 515 orders | Test showed nothing new | SFCC skips existing order numbers; export used 1 year instead of All orders | Not a bug |

## Test evidence

Every order whose commercetools data is consistent matches commercetools exactly; every generated file is valid against order.xsd.

| Test | Orders | Result |
| --- | --- | --- |
| Full export, all dates (before the mapping fixes) | 102,578 | 5 files, all orders present once, same sequence as commercetools |
| Offline mapping: newest and oldest 500 commercetools orders | 1,000 | 0 errors, all valid; totals match on 660; all 39 orders with custom line items match |
| Live: newest, oldest and random orders | 65 | All valid; totals match on 50; real payment methods (scheme, paypal-express, bank_transfer) |
| Sandbox file v003 (last year, new code) | 500 | 203 of 203 registered orders found their customer; 670 of 744 lines linked to a product |
| Sandbox import v005 (Jan–Feb 2023, new code), checked live | 515 | 511 imported, 4 rejected (customer missing); tracking on 489 of 489 shipped orders; 745 of 774 lines linked; totals match on 162, 352 legacy, 1 rounding |
| Sandbox import v001 (last year, old code) | 24,849 | 24,770 imported, 79 rejected; data in the old format, to be replaced after a reset |
| Unit tests | 277 | All pass, including new tests for every change; Shopify and BigCommerce output unchanged |

Warnings in the v005 import that do not block it: 1,625 "attribute undefined" (attributes not created yet), 489 orders with no payment in commercetools, 22 unknown payment methods.

## Known data limitations in commercetools

These differences come from the source data; the export writes what commercetools holds.

- **Legacy orders with inconsistent totals** – older orders bulk-imported into commercetools (for example on 17 Feb 2023) store a total that does not equal their own lines plus shipping. Example: 39.00 + 6.00 shipping stored as 37.20, a 20% discount recorded nowhere. 339 of 1,000 sampled orders.
- **Deleted products and variants** – some orders reference variants no longer in the catalog (SKU 701130-90014, 23 lines in v005) or SKUs moved to re-created products (9004, 345345). These lines keep the SKU as product ID.
- **Tax rounding** – one order's line taxes add up to 10.64 while commercetools stores 10.62.
- **Orders without payments** – most 2023 orders have no payment in commercetools (489 of 515 in v005).

## Open items and decisions

Four items block the final import; the rest can follow or depend on a decision.

| Item | Type | Blocks final import | Estimate |
| --- | --- | --- | --- |
| Run Check Attributes on the order page and create the listed attributes | Setup | Yes | 15 min |
| Separate EU and US customer lists, each assigned to its site | Setup (customer migration) | Yes | Half a day |
| Store filter on the order export (eu-store / us-store) | Code | Yes | Half a day |
| Sandbox reset (or new sandbox) before the final import | Setup | Yes | Depends on Salesforce |
| Payment methods: create the 7 Adyen methods or map them to existing SFCC methods | Decision | No (warnings only) | 1 hour or half a day |
| Legacy orders with inconsistent totals: add a difference adjustment or import as they are | Decision | No | A few hours if chosen |
| One customer missing from the customer export | Customer migration | No | 1 hour |
| Production robustness for about 1M orders: resume after failure, count once, optional gzip | Code | No (before production) | 1–2 days |
| Automatic order import (custom job step) | Code | No | About 1 day |

Payment methods seen in the data: scheme (card), paypal-express, bank_transfer, paypal, pay_by_link, ideal, googlepay.

## Runbook

Import the catalog and customers first; orders go last, one file at a time.

**Before exporting**

1. Deploy the latest bm_accelerator cartridge.
2. Order Migration page: Check Attributes, then create every listed attribute (order, line item, address, payment, price adjustment).
3. The commercetools API client configured in the console needs view_orders and view_customers.

**Export**

1. Choose Date range (All orders for the full migration), optional state filters, optional Max count for a test.
2. Click Check count. About 102,578 means All orders; about 30,034 means only the last year. With a max count, the page shows "N orders will be exported".
3. Click Start Migration (Build XML) and keep the page open. Files are written to IMPEX src/migration/order as order-YYYYMMDD-vNNN-pNNNN.xml.

**Import**

1. Merchant Tools > (site) > Ordering > Import & Export, import each file in order (p0001, p0002, …).
2. Import each region's files into the site that uses that region's customer list.

**Check after each file**

| Log message | Meaning | Action |
| --- | --- | --- |
| Order with number … already exists | Order imported before; not updated | None (reset the sandbox for a clean run) |
| Customer order not imported, because referenced customer does not exist | Customer not in the site's customer list | Check the customer import |
| Object attribute … is undefined | Attribute not created; value dropped | Run Check Attributes before importing |
| Payment method … does not exist | Adyen method not configured | Create the method or accept the warning |
| Order has no payments attached | No payment in commercetools | None |

## Appendix: code changes

All changes are in the order module of bm_accelerator on branch feature/ct-order-migration.

| Area | Files |
| --- | --- |
| Fetch | orders/connectors/ctpOrderConnector.js (cursor paging, exact count, expansions, customer numbers) |
| Mapping | orders/mappers/ctpOrderMapper.js, orders/canonicalOrder.js |
| Product IDs | orders/productIdResolver.js (new) |
| XML | orders/generators/sfccOrderXmlGenerator.js, orders/orderTotalsCalculator.js |
| Batched export | orders/fullMigrationRunner.js, controllers/Accelerator.js, client/default/js/order-migration.js |
| Attributes | orders/orderAttrChecker.js, core/runtimeAttrMap.js, client/default/js/attr-preflight.js |
| Tests | test/unit/bm_accelerator/orders/* (81 order tests; 277 unit tests pass) |
