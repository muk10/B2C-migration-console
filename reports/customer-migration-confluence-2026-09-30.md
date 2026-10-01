# Customer Migration – commercetools to SFCC

Last updated: 30 Sep 2026

The customer export is valid against customer.xsd and 102,968 of 103,377 customer records imported into the test sandbox; the 396 skipped customers are EU/US duplicates that separate customer lists will resolve.

## Page properties

| Property | Value |
| --- | --- |
| Status | Export and test import done; final import pending the EU/US customer list setup |
| Scope | Customers from commercetools project mars-mms-test-us into SFCC (sandbox zzkc-009, site RefArch) |
| Tool | Migration console, cartridge bm_accelerator, customer migration module |
| Contract | SFCC customer.xsd (repo copy, .cursor/references/sfcc-xsd/customer.xsd) |
| Volume | 103,377 customer records (44,138 EU store, 59,222 US store, 17 without a store) |
| Used by | Order migration: registered orders link to customers by customer number |

## Summary

The export is complete and valid; the only import failures come from putting EU and US customers into one customer list.

- **Export:** 103,377 customer records in 7 files, split by commercetools store (eu-store, us-store, no store). All files are valid against customer.xsd.
- **Import:** one job imported all 7 files in 9 minutes: 102,968 customers created, 396 skipped because the same login (email) exists in both the EU and the US store.
- **Orders link correctly:** in the order tests, 203 of 203 and 495 of 499 registered orders found their customer; the misses are the skipped duplicates and one customer missing from the export.
- **Passwords:** each customer gets a unique generated temporary password; real commercetools passwords are not migrated, so customers must reset their password.
- **Recommendation:** for the final import, create one customer list per site (EU, US) and import each store's files into its own list. Then all 103,364 customers import, including the 396 duplicates.

## How the customer migration works

The console builds customer XML files per commercetools store in IMPEX; a Business Manager job imports them into a site's customer list.

1. **Export** – the console reads commercetools customers and writes one series of files per store: `customers-eu-store_customer-<date>-vNNN-pNNNN.xml`, `customers-us-store_customer-…` and `customer-…` for customers without a store. Each file holds about 20,000 customers (up to 28 MB). Folder: IMPEX src/migration/customer.
2. **Import** – the job step ImportCustomers (site scope) imports every matching file from that folder in one run, in MERGE mode, into the site's customer list.

What does not work: Site Import (Administration > Site Import & Export) rejects these files, because it expects a site-export archive with customer lists in the customerlist2 format. The Customers Import & Export page works but takes one file at a time; the job imports all files at once.

Import rules that matter: a login must be unique within one customer list (a duplicate is skipped); a customer number imported twice into the same list is merged (the second record wins); orders can only link to customers in the customer list of the site they are imported into.

## Field mapping

Mapped as found in the 7 exported files; counts are records that carry a value.

| commercetools | customer.xsd element | Records with a value |
| --- | --- | --- |
| customerNumber (else the customer ID) | customer/@customer-no | 103,377 (96,311 customerNumber, 7,053 commercetools ID, 13 other) |
| email | credentials/login and profile/email | 103,377 (login equals email for all) |
| – (generated) | credentials/password, encrypted="false" | 103,377 unique temporary passwords |
| firstName, lastName | profile/first-name, last-name | 103,168 / 103,179 |
| middleName, title, salutation | second-name, title, salutation | 2 / 5 / 24 |
| dateOfBirth | birthday | 2 |
| companyName | company-name | 216 |
| phone | phone-mobile | 65,403 |
| locale | preferred-locale | 5 |
| addresses (default address = preferred) | addresses/address | 111,809 addresses on 62,739 customers |
| customerGroup | customer groups | 253 |
| Custom fields | profile custom-attributes: siteLanguage, siteCountry (103,087), externalImportDate, externalImportSource (96,311), customerType (178), specialPriceEnabled, paymentTerms, electronicAddressId and others | as listed |

The customer number rule (customerNumber, else the commercetools ID) is the one the order migration now uses, so orders and customers match.

## Issues log

Three issues are open (two from the one-list setup, one in the source data), two need a decision, two are fixed and one was not a bug.

| # | Issue | Impact | Fix | Status |
| --- | --- | --- | --- | --- |
| 1 | EU and US customers imported into one customer list | 396 customers skipped ("login is not unique"): the same email exists in both stores. Their orders are rejected | One customer list per site; import each store's files into its own list | Open |
| 2 | 13 customers appear in both the EU and the US files with the same customer number | In one list the second record overwrites the first | Resolved by separate lists | Open |
| 3 | Orders referenced customers by the commercetools ID while customers were imported under customerNumber | 56,051 registered orders would not have linked | Fixed in the order migration (it now uses the same rule) | Fixed |
| 4 | Temporary passwords written in plain text in the import files | Files in IMPEX contain usable passwords | Delete the files after import (or import and archive), and plan a password-reset communication to customers | Decision needed |
| 5 | One customer referenced by an order is not in the customer export | 1 order rejected (1046000571) | Check the customer in commercetools (deleted or filtered out) | Open |
| 6 | If Mars keeps one shared customer list instead | The 396 duplicate customers need merging into one account | Business rule for which profile and addresses win | Decision needed |
| 7 | Site Import rejected the downloaded zip | Import failed | Not a bug: Site Import expects a site-export archive; use the ImportCustomers job | Not a bug |
| 8 | Customers Import & Export page imports one file at a time | 7 manual imports | Job ImportMigrationCustomers imports all files in one run | Fixed |

## Test evidence

The files are valid, the import succeeded, and every skipped customer is explained.

| Test | Result |
| --- | --- |
| customer.xsd validation, all 7 files | Valid |
| Duplicate logins within the EU store / within the US store | 0 / 0 |
| Same login in both EU and US store | 407 (396 skipped by the import) |
| Customer numbers appearing in both store files | 13 |
| Import job ImportMigrationCustomers (30 Sep 2026, 13:08–13:17 GMT) | Status OK; 103,377 processed; 396 skipped (login not unique); 0 other errors |
| Customers in SFCC after the import | 102,968 |
| Order test v003: registered orders whose customer exists | 203 of 203 |
| Order test v005: registered orders whose customer exists | 495 of 499 (3 skipped duplicates, 1 missing from export) |
| Order bulk test v006: orders rejected for a missing customer | 94 of about 30,000 |

Not verified yet: the total against the number of customers in commercetools (needs read access to customers), and customer groups in SFCC.

## Open items and decisions

The customer list setup is the only item that blocks the final import.

| Item | Type | Blocks final import | Owner |
| --- | --- | --- | --- |
| Decide the SFCC site setup: one site per region (EU, US) with its own customer list, or one shared list | Decision | Yes | Architecture / business |
| Create the EU and US customer lists and assign them to their sites | Setup | Yes | Customer migration |
| If one shared list: rule to merge the 396 duplicate customers | Decision | Yes (only in that case) | Business |
| Password handling: reset communication to customers; delete import files after import | Decision + process | No | Business / operations |
| Check the customer missing from the export (order 1046000571) | Investigation | No | Customer migration |
| Reconcile the customer total with commercetools | Check | No | Customer migration |

## Runbook

Import customers before orders, each store into its own customer list.

1. Run the customer migration in the console; the files appear in IMPEX src/migration/customer.
2. Administration > Operations > Jobs > New Job (for example ImportMigrationCustomers). Set the step scope to the site that uses the target customer list.
3. Add the step ImportCustomers with these parameters:

| Parameter | Value |
| --- | --- |
| WorkingFolder | migration/customer |
| FileNamePattern | one store per job run, e.g. `customers-eu-store_customer-20260930-v001-p\d+\.xml` |
| ImportMode | Merge |
| AfterImportFileHandling | Keep (or Archive, to remove files with passwords from the working folder) |
| ImportFailedHandling | WARN |
| NoFilesFoundHandling | ERROR |

4. Run Now, then check the job log in Schedule and History.
5. Repeat for the US store with the US site's scope and pattern.

| Log message | Meaning | Action |
| --- | --- | --- |
| Customer login '…' is not unique. Skipping customer. | Login already in this customer list | Expected in a one-list setup; import stores into separate lists |
| Processed [N] items | Customers read from a file | Compare with the file's customer count |
