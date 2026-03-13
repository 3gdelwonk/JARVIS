# PITFALLS.md — Known Gotchas & Failure Modes

## Invoice Parsing Traps

### 1. Product Code Concatenated with Name
Some invoice lines have the product code smashed against the product name with no space:
```
PAULS SMARTER WHITE 2% FAT MILK BTL 1L00039466    ← code is 00039466
PAULS FHG ORGANIC F/C 1.5L*NASAA3159PML100072019  ← code is 00072019
OAK PLUS FM NO SUGAR ADDED CHOC 6X500ML00070526   ← code is 00070526
```
**Fix**: Regex must handle 8-digit code appearing at end of description string without whitespace.

### 2. Product Names with ** Suffix
Some products have `**` after their name:
```
PAULS ZYMIL FULL CREAM MILK 6x1L**    00022444
PAULS ZYMIL LOW FAT MILK 6X1L **      00016741
```
**Fix**: Strip `**` and extra whitespace during parsing.

### 3. Credit Notes vs Invoices
Three document types in the data:
- **TAX INVOICE** (header says "TAX INVOICE") — normal order, positive amounts
- **Adjustment Note** (header says "Adjustment Note") — credit for out-of-stock items, amounts are "CR"
- **Credit Adjustment Note** (header says "Credit Adjustment Note") — credit for driver errors, amounts are "CR"
**Fix**: Check document header for type. Credit notes should be stored with negative quantities/amounts.

### 4. Multi-Delivery Invoices
A single invoice document can contain 2-3 Delivery Notes for different dates:
```
Invoice 242831270 (ordered 12.01.2026) contains:
  Delivery Note 219611 for 12.1.2026  (13 items, $247.71)
  Delivery Note 220128 for 14.1.2026  (29 items, $447.19)
  Delivery Note 220666 for 16.1.2026  (12 items, $157.50)
```
**Fix**: Parse each Delivery Note as a separate delivery, linked to the parent invoice.

### 5. Price Per Item is the ACTUAL Cost
The invoice shows: List Price → Line Disc → Container Scheme → GST → Extended Price → Price Per Item.
- **List Price** is the base price before discounts
- **Price Per Item** (last column) is the actual cost AFTER all discounts
- For GST-free items, List Price usually = Price Per Item
- For GST-bearing items (flavoured milk), Price Per Item includes discounts but is still ex-GST
**Fix**: Always use Price Per Item as the cost price, not List Price.

### 6. Carton vs Each Units
Most items are `EA` (each), but some bulk items are `CTN` (carton):
```
PAULS FULL CREAM MILK LONGLIFE 12X1L   00017099   4 CTN   124.68   31.17000
```
Here, 4 CTN at $31.17/CTN = $124.68. The `unitsPerOrder` in our product table should reflect this.
**Fix**: Detect unit type (EA vs CTN) and handle accordingly in pricing and quantity calculations.

## Smart Retail Data Traps

### 7. Negative QOH Values
The Stock Report shows QOH values like -3607, -1627, -4292. This happens because POS deducts sales but stock receipts aren't being recorded.
**Fix**: Don't use absolute QOH for stock levels. Instead, calculate velocity from the CHANGE in QOH between imports: `velocity = abs(qoh_change) / days_between`.

### 8. Dual-Supplier Rows
The same barcode appears twice in Item Maintenance — once for Lactalis (supplier 01240657) and once for Metcash (supplier 90770), with different costs.
**Fix**: Store both cost prices on the product record. Use Lactalis cost for ordering, Metcash cost for comparison.

### 9. Cost Price Anomalies
Some Metcash rows have impossibly high cost prices (carton cost in unit field):
```
MOOLOO MOUNTAIN F/CRM 2L — Metcash cost: $56.88 (should be ~$3.16)
PAULS F/HS GOLD 1.5L — Metcash cost: $21.66 (should be ~$3.61)
```
**Fix**: Flag any cost price > $20 per unit for milk products as likely erroneous. Use Lactalis invoice price as ground truth.

### 10. Lactalis Direct Rows Have No Order Codes
In Item Maintenance, rows with Supplier Code 01240657 (Lactalis) have NULL Order Code. Only the Metcash rows (90770) have Order Codes.
**Fix**: The Lactalis product code comes from invoices/portal, NOT from Smart Retail. The mapping is: Smart Retail Barcode ↔ Lactalis Code (maintained in our products table).

## Chrome Extension Traps

### 11. Lactalis Portal Session Timeout
The portal will log you out after inactivity. The extension's content script may be running on a logged-out page.
**Fix**: Before any action, check if the page shows a login form or the expected Quick Order UI. Show "Please log in" message if session expired.

### 12. Quick Order Page DOM Structure
The paste textarea and file upload input may not have stable IDs/classes.
**Fix**: Use multiple selector strategies (ID, class, placeholder text, relative position). Fall back gracefully with an error message if the expected element isn't found.

### 13. File Upload Security Restrictions
Browsers restrict programmatic file upload for security. The DataTransfer API approach may not work on all Chrome versions.
**Fix**: Implement both paste method and upload method. If upload fails, fall back to paste. If both fail, show the order as copyable text.

## Ordering Logic Traps

### 14. Leading Zeros in Product Codes
Lactalis portal Quick Order says: "Please do not include any prefixes, dashes, or other punctuation in the item numbers."
- Invoice code: `00019100` (8 digits with leading zeros)
- Portal SKU: `19100` (no leading zeros)
**Fix**: Always strip leading zeros when generating CSV/paste format for the portal.

### 15. Order vs Delivery Quantity Discrepancy
The invoice shows what was DELIVERED, not necessarily what was ORDERED. Credit notes show items that were ordered but out of stock.
**Fix**: When building the forecast model, use delivered quantities (from invoices) as the baseline. Track credit notes separately to understand supply reliability per SKU.

### 16. Promotional Pricing Changes
Some items have temporary discounts that appear as Line Disc or Container Scheme on invoices. These may change between orders.
**Fix**: Track Price Per Item over time in PriceHistory. Alert when a price changes by more than 5% between consecutive invoices.
