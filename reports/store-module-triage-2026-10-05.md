# Store Migration – commercetools to SFCC: triage

Last updated: 5 Oct 2026

Only three of the six commercetools stores are physical shops. Those three become SFCC stores. The fixes are clear, but before go-live the business needs to confirm the shops' details.

## What commercetools has

| commercetools store | What it is | Orders | SFCC target |
| --- | --- | --- | --- |
| eu-store, us-store | Sales regions | 10,000+ each | SFCC sites (part of the EU/US site decision), not stores |
| test_store | Empty test store | 0 | Not migrated |
| ny-store (New York Store) | Physical shop with pick-up | 438 | SFCC store |
| ds-store (Disney Springs Store) | Physical shop | 4 | SFCC store |
| ld-store (London Store) | Physical shop | 0 | SFCC store |

New York holds address, opening hours and pick-up settings in custom fields, but the values look like test data. Disney Springs has only pick-up instructions, and London has only a name. No store or channel has map coordinates.

## What we fix (development)

The fixes affect the commercetools path only. Shopify, BigCommerce and SAP are unchanged.

| # | Fix | Why |
| --- | --- | --- |
| 1 | Export only the three physical shops; don't show a store without an address in the store locator | Today all six stores are exported, and all are visible in the store locator |
| 2 | Store ID = commercetools key (ny-store) | Today the ID is a long commercetools ID; pick-up orders need a readable, stable reference |
| 3 | Address into the standard SFCC fields (street, address line 2, city, postal code, state, country) | Today only city and postal code land there; country is empty for every store |
| 4 | Weekly opening hours into SFCC store hours, one line per day | Today the hours are stored as raw data that the storefront can't show |
| 5 | Link each store to its inventory list (for example migrated-inventory_ny-warehouse-channel) | Needed for in-store availability and pick-up |
| 6 | Keep pick-up settings (instructions, wait time, order limit, store number) as custom store attributes | SFCC has no standard field for them |
| 7 | Unit tests; give each re-export a new file version instead of overwriting the last file | The module has no tests; same file naming fix as inventory |

Estimate: about 1 day, plus a sandbox import and storefront check.

## What we need from the business

1. **Store locator and pick-up:** should New York, London and Disney Springs appear in the SFCC store locator, offer pick-up in store, or both?
2. **Real store details:** who provides the correct address, phone, opening hours and store number for each shop? The commercetools values for New York look like test data, and London and Disney Springs have almost none.
3. **Map coordinates:** latitude and longitude for each shop. The SFCC store locator searches by distance, so a store without coordinates can't be found. They can be supplied, or looked up from the address.
4. **Time zone for opening hours:** commercetools mixes time zones. Should hours use each shop's local time?
5. **EU/US sites (already open):** which countries, languages, currencies, price books, inventory list and customer list each site gets. The eu-store and us-store settings feed into this.

## Notes

- The 438 New York and 4 Disney Springs orders are store orders, probably pick-up. The order migration will link them to their SFCC store once the store IDs are final.
- Fixes 1 to 7 can start now. Items 2 to 4 above only change the data, not the code.
