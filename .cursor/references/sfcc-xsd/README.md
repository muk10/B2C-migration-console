# SFCC IMPEX XSDs

Canonical Salesforce B2C Commerce import schemas for this repo.

**How agents should use this folder**

| Piece | Role |
|-------|------|
| `.xsd` files here | Source of truth. Read the matching schema **before** changing XML builders. |
| `.cursor/rules/sfcc-*-impex.mdc` | Short, glob-scoped reminders (element order, gotchas). Not a substitute for the XSD. |
| Skills | Do **not** put XSDs in a skill. Skills are for invoked workflows; schema constraints belong in rules + this folder. |

Drop future schemas next to these files using the BM filename. Add a glob-scoped `.mdc` rule for that module’s XML builder.

| Schema | Used by | Rule | Namespace |
|--------|---------|------|-----------|
| `customer.xsd` | Customer migration | `sfcc-customer-impex.mdc` | `http://www.demandware.com/xml/impex/customer/2006-10-31` |
| `catalog.xsd` | Product **and** catalog modules | `sfcc-catalog-impex.mdc` | `http://www.demandware.com/xml/impex/catalog/2006-10-31` |
| `order.xsd` | Order migration | `sfcc-order-impex.mdc` | `http://www.demandware.com/xml/impex/order/2006-10-31` |
| `shipping.xsd` | Shipping method migration | `sfcc-shipping-impex.mdc` | `http://www.demandware.com/xml/impex/shipping/2007-03-31` |
| `inventory.xsd` | Inventory list (and product-module inventory XML) | `sfcc-inventory-impex.mdc` | `http://www.demandware.com/xml/impex/inventory/2007-05-31` |
| `pricebook.xsd` | Pricebook (and product-module pricebook XML) | `sfcc-pricebook-impex.mdc` | `http://www.demandware.com/xml/impex/pricebook/2006-10-31` |
| `store.xsd` | Store migration | `sfcc-store-impex.mdc` | `http://www.demandware.com/xml/impex/store/2007-04-30` |
| `tax.xsd` | Tax migration | `sfcc-tax-impex.mdc` | `http://www.demandware.com/xml/impex/tax/2007-02-14` |

Source: SFCC `DWAPP-23.8.0.139`.
